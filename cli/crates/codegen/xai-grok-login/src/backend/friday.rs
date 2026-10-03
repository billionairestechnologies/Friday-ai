//! The Friday X backend: sign in with a Friday account through the browser (RFC 8628 device code), then
//! use that account's plan, models and usage meter through the Friday gateway.
//!
//! Friday issues one long-lived, revocable token per device (`fxt_…`, shown in Settings → Friday X). It is
//! stored as an OIDC-style session whose issuer is Friday, which is the shape the shell already treats as
//! "first-party" (session bearer to the first-party backend), so the existing session plumbing applies.

use std::sync::Arc;
use std::time::Duration as StdDuration;

use chrono::{Duration, Utc};
use serde::Deserialize;

use super::{AuthBackend, LoginRequest};
use crate::refresh::{DiagnosticUploader, RefreshOutcome, RefreshReason, TokenRefresher};
use crate::{AuthChannels, AuthManager, AuthMode, AuthUrlInfo, AuthUrlMode, GrokAuth, GrokComConfig};

/// Identifies this client to Friday's device login (shown on the approval page and in Settings).
pub const FRIDAY_CLIENT_ID: &str = "friday-x-cli";
const SCOPE: &str = "friday-x";
const SCOPE_KEY: &str = "friday";
const MAX_WAIT: StdDuration = StdDuration::from_secs(15 * 60);

#[derive(Default)]
pub struct FridayAuthBackend;

#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: Option<String>,
    expires_in: Option<i64>,
    interval: Option<u64>,
}

#[derive(Deserialize)]
struct TokenOk {
    access_token: String,
    expires_in: Option<i64>,
}

#[derive(Deserialize)]
struct TokenErr {
    error: String,
    error_description: Option<String>,
}

/// Same origin as the one we sign in to; anything else never sees the token.
fn is_friday_url(url: &str) -> bool {
    let origin = xai_grok_env::friday_origin();
    url == origin || url.strip_prefix(origin.as_str()).is_some_and(|rest| rest.starts_with('/') || rest.starts_with('?'))
}

fn validate_verification_uri(uri: &str) -> anyhow::Result<()> {
    if uri.chars().any(|c| c.is_ascii_control()) {
        anyhow::bail!("Friday returned an invalid sign-in address.");
    }
    let parsed = url::Url::parse(uri).map_err(|_| anyhow::anyhow!("Friday returned an invalid sign-in address."))?;
    match parsed.scheme() {
        "https" => Ok(()),
        "http" if matches!(parsed.host_str(), Some("localhost") | Some("127.0.0.1")) => Ok(()),
        _ => anyhow::bail!("Friday returned an unsupported sign-in address."),
    }
}

async fn open_browser(url: &str) -> bool {
    let url = url.to_owned();
    matches!(tokio::task::spawn_blocking(move || webbrowser::open(&url)).await, Ok(Ok(())))
}

async fn request_code(client: &reqwest::Client, issuer: &str) -> anyhow::Result<DeviceCodeResponse> {
    let resp = client
        .post(format!("{issuer}/oauth2/device/code"))
        .header("x-friday-client-version", xai_grok_version::VERSION)
        .form(&[("client_id", FRIDAY_CLIENT_ID), ("scope", SCOPE)])
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("Couldn't reach Friday ({e}). Check your connection and try again."))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if status.as_u16() == 403 {
            anyhow::bail!("Friday X isn't available for your account yet.");
        }
        anyhow::bail!("Friday couldn't start the sign-in (HTTP {status}). {body}");
    }
    let code: DeviceCodeResponse = resp.json().await?;
    if !code.user_code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        anyhow::bail!("Friday returned an invalid code.");
    }
    validate_verification_uri(&code.verification_uri)?;
    if let Some(complete) = &code.verification_uri_complete {
        validate_verification_uri(complete)?;
    }
    Ok(code)
}

async fn poll_for_token(client: &reqwest::Client, issuer: &str, code: &DeviceCodeResponse) -> anyhow::Result<TokenOk> {
    let mut interval = StdDuration::from_secs(code.interval.unwrap_or(5).max(1));
    let deadline = tokio::time::Instant::now() + StdDuration::from_secs(code.expires_in.unwrap_or(600).clamp(60, 900) as u64).min(MAX_WAIT);
    loop {
        tokio::time::sleep(interval).await;
        if tokio::time::Instant::now() > deadline {
            anyhow::bail!("That code expired. Run `friday login` again.");
        }
        let resp = client
            .post(format!("{issuer}/oauth2/token"))
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("device_code", code.device_code.as_str()),
                ("client_id", FRIDAY_CLIENT_ID),
            ])
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("Couldn't reach Friday ({e})."))?;
        if resp.status().is_success() {
            return Ok(resp.json().await?);
        }
        let err: TokenErr = resp.json().await.unwrap_or(TokenErr { error: "server_error".into(), error_description: None });
        match err.error.as_str() {
            "authorization_pending" => continue,
            "slow_down" => interval += StdDuration::from_secs(5),
            "access_denied" => anyhow::bail!("Sign-in was denied in the browser."),
            "expired_token" => anyhow::bail!("That code expired. Run `friday login` again."),
            _ => anyhow::bail!("Sign-in failed: {}", err.error_description.unwrap_or(err.error)),
        }
    }
}

/// The device-code login. With `channels` (TUI / editor) the URL goes to the front-end, which shows it;
/// without them (plain `friday login`) it is printed to the terminal.
async fn device_login(auth_manager: &Arc<AuthManager>, mut channels: Option<AuthChannels>) -> anyhow::Result<GrokAuth> {
    let issuer = xai_grok_env::friday_api_base();
    let client = xai_grok_http::shared_client();
    let code = request_code(&client, &issuer).await?;
    let display = code.verification_uri_complete.clone().unwrap_or_else(|| format!("{}?code={}", code.verification_uri, code.user_code));

    match channels.take() {
        Some(ch) => {
            if let Some(tx) = ch.url_tx {
                let _ = tx.send(AuthUrlInfo { url: display.clone(), mode: AuthUrlMode::Device });
            }
            open_browser(&display).await;
        }
        None => {
            eprintln!();
            eprintln!("To sign in to Friday X, open this page in your browser:");
            eprintln!();
            eprintln!("  {display}");
            eprintln!();
            if !open_browser(&display).await {
                eprintln!("  (Couldn't open a browser automatically. Open the address above.)");
                eprintln!();
            }
            eprintln!("Check that the page shows this code, then approve:");
            eprintln!();
            eprintln!("  {}", code.user_code);
            eprintln!();
            eprintln!("\x1b[90mOnly continue with a code you just requested.\x1b[0m");
            eprintln!();
            eprintln!("Waiting for approval...");
        }
    }

    let token = poll_for_token(&client, &issuer, &code).await?;
    let now = Utc::now();
    let auth = GrokAuth {
        key: token.access_token,
        auth_mode: AuthMode::Oidc,
        create_time: now,
        user_id: String::new(),
        email: None,
        first_name: None,
        last_name: None,
        profile_image_asset_id: None,
        principal_type: None,
        principal_id: None,
        organization_id: None,
        organization_name: None,
        organization_role: None,
        team_id: None,
        team_name: None,
        team_role: None,
        user_blocked_reason: None,
        team_blocked_reasons: vec![],
        coding_data_retention_opt_out: true,
        can_administer_team: None,
        has_grok_code_access: None,
        refresh_token: None,
        expires_at: Some(now + Duration::seconds(token.expires_in.unwrap_or(365 * 24 * 3600))),
        oidc_issuer: Some(issuer),
        oidc_client_id: Some(FRIDAY_CLIENT_ID.to_owned()),
    };
    auth_manager.update(auth).await.map_err(|e| anyhow::anyhow!("Couldn't save your sign-in: {e}"))
}

#[async_trait::async_trait(?Send)]
impl AuthBackend for FridayAuthBackend {
    fn scope_key(&self, _config: &GrokComConfig) -> String {
        SCOPE_KEY.to_owned()
    }

    fn inherited_scopes(&self) -> &'static [&'static str] {
        &[]
    }

    fn owns(&self, auth: &GrokAuth) -> bool {
        auth.auth_mode == AuthMode::Oidc && auth.oidc_issuer.as_deref().is_some_and(crate::is_xai_oauth2_issuer)
    }

    /// The session token reaches the Friday origin and nothing else, whatever a models list or config file says.
    fn may_receive_session(&self, url: &str) -> bool {
        is_friday_url(url)
    }

    fn login_host(&self, _config: &GrokComConfig) -> String {
        super::host_of(&xai_grok_env::friday_origin())
    }

    /// Friday IS the first-party authority in this build: the flag gates "send the session to the first-party
    /// backend", and that backend is Friday (see `is_trusted_xai_https_url`, which names the same origin).
    fn is_xai_authority(&self) -> bool {
        true
    }

    async fn login(&self, req: LoginRequest<'_>) -> anyhow::Result<(GrokAuth, bool)> {
        if req.reauth {
            req.auth_manager.clear()?;
        }
        if !req.force_interactive && !req.reauth {
            if let Some(auth) = req.auth_manager.current() {
                return Ok((auth, false));
            }
        }
        let url_tx = req.url_tx.and_then(|rc| rc.borrow_mut().take());
        let channels = req.code_rx.map(|code_rx| AuthChannels { url_tx, code_rx });
        Ok((device_login(req.auth_manager, channels).await?, true))
    }

    fn refresher(
        &self,
        _manager: Arc<AuthManager>,
        _auth_provider_command: Option<String>,
        _diagnostic_uploader: Option<DiagnosticUploader>,
    ) -> Arc<dyn TokenRefresher> {
        Arc::new(FridayRefresher)
    }
}

/// Friday tokens don't rotate: a token is valid until it is signed out (Settings → Friday X) or its year
/// is up, and either way the remedy is a new login, so "refresh" is an immediate, permanent no.
struct FridayRefresher;

#[async_trait::async_trait]
impl TokenRefresher for FridayRefresher {
    async fn refresh(&self, _reason: RefreshReason) -> RefreshOutcome {
        RefreshOutcome::permanent(crate::error::RefreshTokenFailedReason::RefreshTokenRejected, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_token_only_goes_to_the_friday_origin() {
        let origin = xai_grok_env::friday_origin();
        assert!(is_friday_url(&format!("{origin}/api/x/v1")));
        assert!(is_friday_url(&origin));
        assert!(!is_friday_url(&format!("{origin}.evil.example/api/x/v1")));
        assert!(!is_friday_url("https://api.x.ai/v1"));
        assert!(!is_friday_url("https://example.com/?next=friday.billionairestechnologies.com"));
    }

    #[test]
    fn verification_uris_must_be_https_or_loopback_http() {
        assert!(validate_verification_uri("https://friday.example.com/device?code=ABCD-EFGH").is_ok());
        assert!(validate_verification_uri("http://localhost:5173/device").is_ok());
        assert!(validate_verification_uri("http://friday.example.com/device").is_err());
        assert!(validate_verification_uri("javascript:alert(1)").is_err());
    }
}
