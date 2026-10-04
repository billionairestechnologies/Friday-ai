//! End-to-end tests for FridayX's self-update against a mock of the Friday backend's release endpoints:
//! `GET /version` (plain text), `GET /download/<platform>?version=` and `GET /sha256/<platform>?version=`.
//!
//! They prove the property that matters: a download is activated only if its SHA-256 equals what Friday
//! publishes, and a mismatch (or a missing checksum) leaves the previous install untouched.
//!
//! The install reads `grok_home()` (a process-wide `OnceLock`), so every test runs serially against one `FRIDAY_HOME`.

#![cfg(unix)]

mod common;

use serial_test::serial;
use sha2::{Digest, Sha256};
use wiremock::matchers::{method, path, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

use common::{reset_home, test_home};
use xai_grok_update::UpdateConfig;
use xai_grok_update::auto_update::install_internal_from_base;

/// The platform id Friday's release endpoints use for this machine.
fn friday_platform() -> String {
    let os = if cfg!(target_os = "macos") { "darwin" } else { "linux" };
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    format!("{os}-{arch}")
}

fn make_config() -> UpdateConfig {
    UpdateConfig {
        proxy_base_url: "http://test.invalid/v1".to_string(),
        auth_scope: "test".to_string(),
        deployment_key: None,
        alpha_test_key: None,
        channel: "stable".to_string(),
        npm_registry: None,
    }
}

const BINARY: &[u8] = b"#!/bin/sh\necho \"friday 9.9.9\"\n";

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// A Friday release server. `published_sha` is what `/sha256/...` says (`None` = 404, no checksum published).
async fn friday_server(version: &str, published_sha: Option<String>) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/version"))
        .respond_with(ResponseTemplate::new(200).set_body_string(format!("{version}\n")))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/download/.+"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(BINARY.to_vec()))
        .mount(&server)
        .await;
    let sha_response = match published_sha {
        Some(sha) => ResponseTemplate::new(200).set_body_string(format!("{sha}\n")),
        None => ResponseTemplate::new(404),
    };
    Mock::given(method("GET"))
        .and(path_regex(r"^/sha256/.+"))
        .respond_with(sha_response)
        .mount(&server)
        .await;
    server
}

#[tokio::test]
#[serial]
async fn a_verified_download_is_installed_and_activated() {
    let _ = test_home();
    reset_home();
    let server = friday_server("9.9.9", Some(sha256_hex(BINARY))).await;

    install_internal_from_base(Some("9.9.9"), &make_config(), &server.uri())
        .await
        .expect("a download that matches its published checksum installs");

    let home = test_home();
    let link = home.join("bin").join("friday");
    assert!(link.is_symlink(), "the friday command is linked");
    let target = std::fs::read_link(&link).unwrap();
    assert!(target.to_string_lossy().contains("friday-9.9.9-"), "{target:?}");
    assert!(home.join("bin").join("agent").is_symlink(), "agent moves with friday");
}

#[tokio::test]
#[serial]
async fn the_version_comes_from_the_version_endpoint_when_none_is_pinned() {
    let _ = test_home();
    reset_home();
    let server = friday_server("9.9.9", Some(sha256_hex(BINARY))).await;

    let installed = install_internal_from_base(None, &make_config(), &server.uri())
        .await
        .expect("installs the version the server names");
    assert_eq!(installed, "9.9.9");
}

#[tokio::test]
#[serial]
async fn a_download_that_does_not_match_its_checksum_is_refused_and_never_activated() {
    let _ = test_home();
    reset_home();
    // The server publishes the checksum of different bytes: what was downloaded is not what Friday vouches for.
    let server = friday_server("9.9.9", Some(sha256_hex(b"something else"))).await;

    let err = install_internal_from_base(Some("9.9.9"), &make_config(), &server.uri())
        .await
        .expect_err("a tampered or corrupt download must not install");
    assert!(format!("{err:#}").contains("checksum"), "{err:#}");

    let home = test_home();
    assert!(!home.join("bin").join("friday").exists(), "nothing was activated");
    let leftover = home.join("downloads").join(format!("friday-9.9.9-{}", platform_dir_suffix()));
    assert!(!leftover.exists(), "the rejected file was deleted");
}

#[tokio::test]
#[serial]
async fn a_download_with_no_published_checksum_is_refused() {
    let _ = test_home();
    reset_home();
    let server = friday_server("9.9.9", None).await;

    install_internal_from_base(Some("9.9.9"), &make_config(), &server.uri())
        .await
        .expect_err("no checksum, no install");
    assert!(!test_home().join("bin").join("friday").exists());
}

#[tokio::test]
#[serial]
async fn the_version_pointer_is_plain_text_and_trimmed() {
    let _ = test_home();
    reset_home();
    let server = friday_server("1.2.3", None).await;

    let v = xai_grok_update::version::fetch_gcs_version_from_base("stable", &server.uri())
        .await
        .unwrap();
    assert_eq!(v, "1.2.3");
}

/// The name the installer gives the downloaded file (`<os>-<arch>` in the original naming).
fn platform_dir_suffix() -> String {
    let os = if cfg!(target_os = "macos") { "macos" } else { "linux" };
    let arch = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x86_64" };
    format!("{os}-{arch}")
}
