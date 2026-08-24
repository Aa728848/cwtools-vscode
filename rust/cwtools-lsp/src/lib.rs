#![forbid(unsafe_code)]
#![allow(clippy::match_same_arms)]

use std::collections::BTreeSet;

use cwtools_protocol::{JsonRpcError, Lifecycle, Message, RequestId};
use serde_json::{Value, json};

pub mod local;

const MANIFEST: &str = include_str!("../../../contracts/lsp-manifest.json");
const REQUEST_CANCELLED: i64 = -32_800;
const INVALID_REQUEST: i64 = -32_600;
const METHOD_NOT_FOUND: i64 = -32_601;

#[derive(Debug, Default)]
pub struct Router {
    lifecycle: Lifecycle,
    local: local::LocalRouter,
    cancelled: BTreeSet<String>,
}

impl Router {
    /// Routes one complete JSON-RPC message and keeps all semantic work local.
    #[must_use]
    pub fn route(&mut self, message: &Message) -> Option<Message> {
        let method = message.method.as_deref()?;
        if method == "$/cancelRequest" {
            let _ = self.lifecycle.observe(method);
            if let Some(cancelled) = message.params.as_ref().and_then(cancel_id) {
                self.cancelled.insert(cancelled);
            }
            return None;
        }

        if is_lifecycle_method(method) {
            if let Err(error) = self.lifecycle.observe(method) {
                return message.id.clone().map(|id| {
                    error_response(
                        id,
                        INVALID_REQUEST,
                        &format!("Invalid lifecycle transition: {error:?}"),
                    )
                });
            }
            return match method {
                "initialize" => {
                    self.configure_initialize(message.params.as_ref());
                    message
                        .id
                        .clone()
                        .map(|id| response(id, initialize_result()))
                }
                "initialized" | "exit" => None,
                "shutdown" => message.id.clone().map(|id| response(id, Value::Null)),
                _ => None,
            };
        }

        if self.lifecycle != Lifecycle::Initialized {
            return message
                .id
                .clone()
                .map(|id| error_response(id, INVALID_REQUEST, "The server is not initialized"));
        }

        if let Some(id) = message.id.as_ref() {
            let key = request_id_key(id);
            if self.cancelled.remove(&key) {
                return Some(error_response(
                    id.clone(),
                    REQUEST_CANCELLED,
                    "Request cancelled",
                ));
            }
        }

        self.local.handle(message).or_else(|| {
            message
                .id
                .clone()
                .map(|id| error_response(id, METHOD_NOT_FOUND, "Method not found"))
        })
    }

    /// Drains deterministic server notifications emitted by local adapters.
    pub fn drain_notifications(&mut self) -> Vec<Message> {
        self.local.drain_notifications()
    }

    #[must_use]
    pub fn is_exited(&self) -> bool {
        self.lifecycle == Lifecycle::Exited
    }

    fn configure_initialize(&mut self, params: Option<&Value>) {
        let root = params
            .and_then(|value| value.get("rootUri"))
            .and_then(Value::as_str)
            .or_else(|| {
                params
                    .and_then(|value| value.get("rootPath"))
                    .and_then(Value::as_str)
            })
            .map(str::to_owned);
        let advertised = manifest_command_names(true);
        let all = manifest_command_names(false);
        self.local.set_workspace_root(root);
        self.local.set_commands(advertised, all);
    }
}

fn is_lifecycle_method(method: &str) -> bool {
    matches!(method, "initialize" | "initialized" | "shutdown" | "exit")
}

fn cancel_id(params: &Value) -> Option<String> {
    let id = params.get("id")?;
    let request_id = serde_json::from_value::<RequestId>(id.clone()).ok()?;
    Some(request_id_key(&request_id))
}

fn request_id_key(id: &RequestId) -> String {
    serde_json::to_string(id).unwrap_or_else(|_| "null".to_owned())
}

fn manifest_value() -> Value {
    serde_json::from_str(MANIFEST).expect("checked-in LSP manifest must be valid JSON")
}

fn manifest_command_names(advertised_only: bool) -> Vec<String> {
    manifest_value()["commands"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|command| !advertised_only || command["advertised"].as_bool() == Some(true))
        .filter_map(|command| command["name"].as_str().map(str::to_owned))
        .collect()
}

fn initialize_result() -> Value {
    let manifest = manifest_value();
    let capabilities = &manifest["capabilities"];
    let advertised_commands = manifest_command_names(true);
    json!({
        "capabilities": {
            "textDocumentSync": {
                "openClose": true,
                "change": 2,
                "willSave": true,
                "willSaveWaitUntil": false,
                "save": { "includeText": true }
            },
            "hoverProvider": true,
            "completionProvider": {
                "resolveProvider": true,
                "triggerCharacters": capabilities["completionTriggerCharacters"]
            },
            "signatureHelpProvider": {
                "triggerCharacters": capabilities["signatureTriggerCharacters"]
            },
            "definitionProvider": true,
            "referencesProvider": true,
            "documentHighlightProvider": true,
            "documentSymbolProvider": true,
            "workspaceSymbolProvider": true,
            "codeActionProvider": { "codeActionKinds": ["quickfix", "source", "source.format"] },
            "codeLensProvider": { "resolveProvider": true },
            "documentFormattingProvider": true,
            "documentRangeFormattingProvider": true,
            "renameProvider": { "prepareProvider": true },
            "documentLinkProvider": { "resolveProvider": true },
            "executeCommandProvider": { "commands": advertised_commands },
            "inlayHintProvider": { "resolveProvider": false },
            "foldingRangeProvider": true,
            "selectionRangeProvider": true,
            "callHierarchyProvider": true,
            "semanticTokensProvider": {
                "legend": {
                    "tokenTypes": capabilities["semanticTokens"]["tokenTypes"],
                    "tokenModifiers": capabilities["semanticTokens"]["tokenModifiers"]
                },
                "range": false,
                "full": { "delta": true }
            }
        },
        "serverInfo": { "name": "cwtools-rust", "version": env!("CARGO_PKG_VERSION") }
    })
}

fn response(id: RequestId, result: Value) -> Message {
    Message {
        jsonrpc: "2.0".to_owned(),
        id: Some(id),
        method: None,
        params: None,
        result: Some(result),
        error: None,
    }
}

fn error_response(id: RequestId, code: i64, message: &str) -> Message {
    Message {
        jsonrpc: "2.0".to_owned(),
        id: Some(id),
        method: None,
        params: None,
        result: None,
        error: Some(JsonRpcError {
            code,
            message: message.to_owned(),
            data: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: i64, method: &str, params: Value) -> Message {
        Message {
            jsonrpc: "2.0".to_owned(),
            id: Some(RequestId::Number(id)),
            method: Some(method.to_owned()),
            params: Some(params),
            result: None,
            error: None,
        }
    }

    fn notification(method: &str, params: Value) -> Message {
        Message {
            jsonrpc: "2.0".to_owned(),
            id: None,
            method: Some(method.to_owned()),
            params: Some(params),
            result: None,
            error: None,
        }
    }

    #[test]
    fn advertises_manifest_commands_and_utf16_semantic_delta() {
        let mut router = Router::default();
        let initialize = router
            .route(&request(
                1,
                "initialize",
                json!({ "rootUri":"file:///workspace" }),
            ))
            .expect("initialize response");
        let result = initialize.result.expect("initialize result");
        let advertised = result["capabilities"]["executeCommandProvider"]["commands"]
            .as_array()
            .expect("commands");
        assert!(advertised.iter().any(|value| value == "cacheVanilla"));
        assert_eq!(
            result["capabilities"]["semanticTokensProvider"]["full"]["delta"],
            true
        );
        assert_eq!(result["capabilities"]["textDocumentSync"]["change"], 2);
    }

    #[test]
    fn lifecycle_cancel_and_notifications_are_local() {
        let mut router = Router::default();
        assert!(router.route(&request(1, "initialize", json!({}))).is_some());
        assert!(
            router
                .route(&notification("initialized", json!({})))
                .is_none()
        );
        assert!(router.route(&notification("textDocument/didOpen", json!({
            "textDocument": {"uri":"file:///x.txt","languageId":"paradox","version":1,"text":"x = {"}
        }))).is_none());
        assert!(router.drain_notifications().iter().any(|message| message.method.as_deref() == Some("textDocument/publishDiagnostics")));
        assert!(
            router
                .route(&notification("$/cancelRequest", json!({"id":4})))
                .is_none()
        );
        let cancelled = router
            .route(&request(4, "workspace/symbol", json!({"query":"x"})))
            .expect("cancel response");
        assert_eq!(
            cancelled.error.expect("cancel error").code,
            REQUEST_CANCELLED
        );
    }

    #[test]
    fn rejects_requests_before_initialize_and_after_shutdown() {
        let mut router = Router::default();
        let response = router
            .route(&request(1, "workspace/symbol", json!({"query":""})))
            .expect("error");
        assert_eq!(response.error.expect("error").code, INVALID_REQUEST);
        assert!(router.route(&request(2, "initialize", json!({}))).is_some());
        assert!(
            router
                .route(&notification("initialized", json!({})))
                .is_none()
        );
        assert!(router.route(&request(3, "shutdown", Value::Null)).is_some());
        assert!(router.route(&notification("exit", Value::Null)).is_none());
        let response = router
            .route(&request(4, "workspace/symbol", json!({"query":""})))
            .expect("error");
        assert_eq!(response.error.expect("error").code, INVALID_REQUEST);
    }
}
