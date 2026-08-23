//! `GET /dashboard` — the control-plane landing page. The CLI's `ori
//! dashboard` opens this URL, derived from the configured api-url rather than
//! a hardcoded domain.

use axum::extract::State;
use axum::response::{Html, IntoResponse, Response};

use crate::state::AppState;

pub async fn page(State(state): State<AppState>) -> Response {
    let base = format!("http://{}", state.config.listen_addr);
    let page = format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ori control plane</title>
<style>
  body {{ font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }}
  h1 {{ font-size: 1.6rem; }} code {{ background: #f0f0f0; padding: 0.15em 0.35em; border-radius: 4px; }}
</style>
</head>
<body>
<h1>ori</h1>
<p>The control plane at <code>{domain}</code> is healthy.</p>
<p>Manage machines with the CLI: <code>ori --api-url {base} list</code></p>
</body>
</html>"#,
        domain = state.config.domain,
        base = base,
    );
    Html(page).into_response()
}
