//! Plan usage for the status bar: "Usage 12%". The numbers are Friday's (`GET /api/x/me`, the same percent-and-reset
//! windows the web app shows), so a plan or limit edited in the Console shows up here with no new release. Credits and
//! prices never reach the client — only a percentage.

use std::sync::{Once, RwLock};
use std::time::Duration;

use serde::Deserialize;
use xai_grok_shell_base::util::grok_home;

/// What the bar shows: the tightest window (the one closest to a limit) and how full it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageLabel {
    pub text: String,
    pub percent: u8,
}

static CURRENT: RwLock<Option<UsageLabel>> = RwLock::new(None);
static STARTED: Once = Once::new();

const POLL_EVERY: Duration = Duration::from_secs(45);

#[derive(Deserialize)]
struct Me {
    usage: Option<MeUsage>,
}
#[derive(Deserialize)]
struct MeUsage {
    windows: Vec<MeWindow>,
}
#[derive(Deserialize)]
struct MeWindow {
    label: String,
    percent: f64,
}

/// Latest usage, `None` until the first answer (or when signed out / offline). Starts the poller on first call —
/// rendering is synchronous but always runs inside the app's tokio runtime.
pub fn usage_label() -> Option<UsageLabel> {
    STARTED.call_once(|| {
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async {
                loop {
                    refresh().await;
                    tokio::time::sleep(POLL_EVERY).await;
                }
            });
        }
    });
    CURRENT.read().ok().and_then(|g| g.clone())
}

fn token() -> Option<String> {
    let store = crate::read_auth_json(&crate::auth_json_path(&grok_home::grok_home())).ok()?;
    store.values().map(|a| a.key.clone()).find(|k| k.starts_with("fxt_"))
}

fn tightest(me: Me) -> Option<UsageLabel> {
    let w = me
        .usage?
        .windows
        .into_iter()
        .max_by(|a, b| a.percent.partial_cmp(&b.percent).unwrap_or(std::cmp::Ordering::Equal))?;
    let percent = w.percent.round().clamp(0.0, 100.0) as u8;
    Some(UsageLabel { text: format!("{} {}%", w.label, percent), percent })
}

async fn refresh() {
    let Some(token) = token() else {
        if let Ok(mut g) = CURRENT.write() {
            *g = None;
        }
        return;
    };
    let url = format!("{}/me", xai_grok_env::friday_api_base());
    let client = xai_grok_http::shared_client();
    let Ok(resp) = client.get(url).bearer_auth(token).timeout(Duration::from_secs(8)).send().await else { return };
    if !resp.status().is_success() {
        return;
    }
    let Ok(me) = resp.json::<Me>().await else { return };
    if let Ok(mut g) = CURRENT.write() {
        *g = tightest(me);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shows_the_window_closest_to_its_limit() {
        let me: Me = serde_json::from_str(
            r#"{"usage":{"windows":[{"label":"5-hour","percent":12.4},{"label":"Weekly","percent":61.6},{"label":"Monthly","percent":3}]}}"#,
        )
        .unwrap();
        assert_eq!(tightest(me), Some(UsageLabel { text: "Weekly 62%".into(), percent: 62 }));
    }

    #[test]
    fn no_windows_means_nothing_to_show() {
        let me: Me = serde_json::from_str(r#"{"usage":{"windows":[]}}"#).unwrap();
        assert_eq!(tightest(me), None);
    }
}
