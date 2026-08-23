//! HTTP client for the control plane. Base is `{ORI_API_URL}/api/v1`, JSON in,
//! JSON out, `Authorization: Bearer <token>`. Streaming endpoints keep the raw
//! `reqwest::Response` so the caller can consume the NDJSON as it arrives.

use reqwest::header::AUTHORIZATION;
use reqwest::{Method, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{ApiError, CliError};

#[derive(Clone)]
pub struct Api {
    base: String,
    pub token: Option<String>,
    client: reqwest::Client,
}

impl Api {
    pub fn new(api_url: &str, token: Option<String>) -> Self {
        let base = normalize_base(api_url);
        let client = reqwest::Client::builder()
            .build()
            .expect("failed to build reqwest client");
        Self {
            base,
            token,
            client,
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    fn url(&self, path: &str) -> String {
        format!(
            "{}/{}",
            self.base.trim_end_matches('/'),
            path.trim_start_matches('/')
        )
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> Result<Response, CliError> {
        let mut req = self.client.request(method, self.url(path));
        if let Some(tok) = &self.token {
            req = req.header(AUTHORIZATION, format!("Bearer {tok}"));
        }
        if let Some(body) = body {
            req = req.json(body);
        }
        let res = req.send().await.map_err(|e| {
            CliError::Api(ApiError {
                status: 0,
                code: "network".into(),
                message: e.to_string(),
            })
        })?;
        let status = res.status();
        if !status.is_success() {
            return Err(self.error_from_response(res, status).await);
        }
        Ok(res)
    }

    async fn error_from_response(&self, res: Response, status: StatusCode) -> CliError {
        let text = res.text().await.unwrap_or_default();
        let (code, mut message) = parse_error_body(&text).unwrap_or_else(|| {
            let message = if text.is_empty() {
                status.canonical_reason().unwrap_or("error").to_string()
            } else {
                text
            };
            (status.as_str().to_string(), message)
        });
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            message = format!("{message}; run `ori login`");
        }
        CliError::Api(ApiError {
            status: status.as_u16(),
            code,
            message,
        })
    }

    pub async fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T, CliError> {
        let res = self.send(Method::GET, path, None).await?;
        res.json::<T>().await.map_err(|e| {
            CliError::Api(ApiError {
                status: 0,
                code: "bad_response".into(),
                message: e.to_string(),
            })
        })
    }

    /// `GET` returning the raw response for a caller that consumes the body as
    /// a stream (`snapshot pull`). The status is checked here, so a 4xx/5xx
    /// still becomes an `ApiError` with the server's reason.
    pub async fn get(&self, path: &str) -> Result<Response, CliError> {
        self.send(Method::GET, path, None).await
    }

    pub async fn post_json<T: DeserializeOwned>(
        &self,
        path: &str,
        body: &impl Serialize,
    ) -> Result<T, CliError> {
        let v = serde_json::to_value(body)?;
        let res = self.send(Method::POST, path, Some(&v)).await?;
        res.json::<T>().await.map_err(|e| {
            CliError::Api(ApiError {
                status: 0,
                code: "bad_response".into(),
                message: e.to_string(),
            })
        })
    }

    /// `POST` returning the raw response (caller consumes body / streams NDJSON).
    pub async fn post(&self, path: &str, body: &impl Serialize) -> Result<Response, CliError> {
        let v = serde_json::to_value(body)?;
        self.send(Method::POST, path, Some(&v)).await
    }

    /// `POST` for streaming endpoints (`new` / `resume` / `fork`).
    pub async fn post_stream(
        &self,
        path: &str,
        body: &impl Serialize,
    ) -> Result<Response, CliError> {
        self.post(path, body).await
    }

    pub async fn delete(&self, path: &str) -> Result<Response, CliError> {
        self.send(Method::DELETE, path, None).await
    }
}

fn normalize_base(url: &str) -> String {
    let mut s = url.trim().trim_end_matches('/').to_string();
    if !s.ends_with("/api/v1") {
        s.push_str("/api/v1");
    }
    s
}

/// Tolerate `{"error": {"code": ..., "message": ...}}` and `{"error": "..."}`.
fn parse_error_body(text: &str) -> Option<(String, String)> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let e = v.get("error")?;
    if let (Some(code), Some(message)) = (
        e.get("code").and_then(|c| c.as_str()),
        e.get("message").and_then(|m| m.as_str()),
    ) {
        return Some((code.to_string(), message.to_string()));
    }
    e.as_str().map(|m| ("error".to_string(), m.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_base_to_api_v1() {
        assert_eq!(
            normalize_base("https://api.ori.dev"),
            "https://api.ori.dev/api/v1"
        );
        assert_eq!(
            normalize_base("https://api.ori.dev/"),
            "https://api.ori.dev/api/v1"
        );
        assert_eq!(
            normalize_base("https://host.example/api/v1"),
            "https://host.example/api/v1"
        );
    }

    #[test]
    fn parses_error_bodies() {
        assert_eq!(
            parse_error_body(
                r#"{"error":{"code":"provider_unavailable","message":"no capacity"}}"#
            ),
            Some(("provider_unavailable".into(), "no capacity".into()))
        );
        assert_eq!(
            parse_error_body(r#"{"error":"oops"}"#),
            Some(("error".into(), "oops".into()))
        );
        assert_eq!(parse_error_body("plain text"), None);
    }
}
