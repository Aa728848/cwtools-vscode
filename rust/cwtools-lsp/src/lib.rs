#![forbid(unsafe_code)]
#![allow(clippy::match_same_arms)]

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use cwtools_protocol::{JsonRpcError, Lifecycle, Message, RequestId};
use serde_json::{Value, json};

pub mod local;

const MANIFEST: &str = include_str!("../../../contracts/lsp-manifest.json");
const REQUEST_CANCELLED: i64 = -32_800;
const INVALID_REQUEST: i64 = -32_600;
const METHOD_NOT_FOUND: i64 = -32_601;
const MAX_REVERSE_REQUESTS: usize = 64;
const MAX_OPTION_CHARS: usize = 32 * 1024;

pub type CancellationRegistry = Arc<Mutex<BTreeSet<String>>>;

#[derive(Debug, Default)]
pub struct Router {
    lifecycle: Lifecycle,
    local: local::LocalRouter,
    cancelled: CancellationRegistry,
    next_reverse_id: i64,
    pending_reverse: BTreeMap<String, local::ReverseRequestKind>,
    outgoing: Vec<Message>,
}

impl Router {
    #[must_use]
    pub fn with_read_only(read_only: bool) -> Self {
        let mut router = Self::default();
        router.local.set_read_only(read_only);
        router
    }

    #[must_use]
    pub fn cancellation_registry(&self) -> CancellationRegistry {
        Arc::clone(&self.cancelled)
    }

    pub fn cancel(registry: &CancellationRegistry, id: &RequestId) {
        if let Ok(mut cancelled) = registry.lock() {
            cancelled.insert(request_id_key(id));
        }
    }

    #[must_use]
    pub fn take_cancelled(&self, id: &RequestId) -> bool {
        self.cancelled
            .lock()
            .is_ok_and(|mut cancelled| cancelled.remove(&request_id_key(id)))
    }

    #[must_use]
    pub fn cancelled_response(id: RequestId) -> Message {
        error_response(id, REQUEST_CANCELLED, "Request cancelled")
    }

    /// Routes one complete JSON-RPC message and keeps all semantic work local.
    #[must_use]
    pub fn route(&mut self, message: &Message) -> Option<Message> {
        if message.method.is_none() {
            self.correlate_reverse_response(message);
            return None;
        }
        let method = message.method.as_deref()?;
        if method == "$/cancelRequest" {
            let _ = self.lifecycle.observe(method);
            if let Some(id) = message.params.as_ref().and_then(cancel_request_id) {
                Self::cancel(&self.cancelled, &id);
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
                "initialized" => {
                    self.local.notify_server_ready();
                    let _ = self.local.queue_watched_files_registration();
                    self.collect_reverse_requests();
                    None
                }
                "exit" => None,
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
            if self.take_cancelled(id) {
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

    pub fn drain_outgoing(&mut self) -> Vec<Message> {
        self.collect_reverse_requests();
        std::mem::take(&mut self.outgoing)
    }

    #[must_use]
    pub fn pending_reverse_count(&self) -> usize {
        self.pending_reverse.len()
    }

    pub fn request_apply_edit(&mut self, label: Option<&str>, edit: Value) -> bool {
        let queued = self.local.queue_apply_edit(label, edit);
        self.collect_reverse_requests();
        queued
    }

    fn collect_reverse_requests(&mut self) {
        for reverse in self.local.drain_reverse_requests() {
            if self.pending_reverse.len() >= MAX_REVERSE_REQUESTS {
                break;
            }
            self.next_reverse_id = self.next_reverse_id.saturating_add(1).max(1);
            let id = RequestId::Number(-self.next_reverse_id);
            self.pending_reverse
                .insert(request_id_key(&id), reverse.kind);
            self.outgoing
                .push(server_request(id, reverse.method, reverse.params));
        }
    }

    fn correlate_reverse_response(&mut self, message: &Message) {
        let Some(id) = message.id.as_ref() else {
            return;
        };
        let Some(kind) = self.pending_reverse.remove(&request_id_key(id)) else {
            return;
        };
        if message.error.is_some() {
            self.local.notify_reverse_failure(kind);
        }
    }

    #[must_use]
    pub fn is_exited(&self) -> bool {
        self.lifecycle == Lifecycle::Exited
    }

    #[must_use]
    pub fn is_shutdown(&self) -> bool {
        matches!(self.lifecycle, Lifecycle::Shutdown | Lifecycle::Exited)
    }

    fn configure_initialize(&mut self, params: Option<&Value>) {
        let root = bounded_string(params.and_then(|value| value.get("rootUri")))
            .or_else(|| bounded_string(params.and_then(|value| value.get("rootPath"))));
        let folders = params
            .and_then(|value| value.get("workspaceFolders"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|folder| {
                Some(local::WorkspaceFolder {
                    uri: folder.get("uri")?.as_str()?.to_owned(),
                    name: folder
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("workspace")
                        .to_owned(),
                })
            })
            .collect();
        let options = params
            .and_then(|value| value.get("initializationOptions"))
            .filter(|value| {
                serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= MAX_OPTION_CHARS)
            })
            .cloned()
            .unwrap_or(Value::Null);
        let insert_replace_support = params
            .and_then(|value| {
                value.pointer(
                    "/capabilities/textDocument/completion/completionItem/insertReplaceSupport",
                )
            })
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let advertised = manifest_command_names(true);
        let all = manifest_command_names(false);
        self.local.configure(
            root,
            folders,
            local::InitializationState {
                language: options
                    .get("language")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                ui_language: options
                    .get("uiLanguage")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                is_vanilla_folder: options
                    .get("isVanillaFolder")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                rules_cache: options
                    .get("rulesCache")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                bundled_rules_path: options
                    .get("bundledRulesPath")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                rules_version: options
                    .get("rules_version")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                default_repo_path: options
                    .get("defaultRepoPath")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                repo_path: options
                    .get("repoPath")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                diagnostic_logging: options
                    .get("diagnosticLogging")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                insert_replace_support,
                watched_files_dynamic_registration: params
                    .and_then(|value| {
                        value.pointer(
                            "/capabilities/workspace/didChangeWatchedFiles/dynamicRegistration",
                        )
                    })
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            },
        );
        self.local.set_commands(advertised, all);
    }
}

fn is_lifecycle_method(method: &str) -> bool {
    matches!(method, "initialize" | "initialized" | "shutdown" | "exit")
}

#[must_use]
pub fn cancel_request_id(params: &Value) -> Option<RequestId> {
    serde_json::from_value(params.get("id")?.clone()).ok()
}

fn request_id_key(id: &RequestId) -> String {
    serde_json::to_string(id).unwrap_or_else(|_| "null".to_owned())
}

fn bounded_string(value: Option<&Value>) -> Option<String> {
    let string = value.and_then(Value::as_str)?;
    (string.chars().count() <= MAX_OPTION_CHARS).then(|| string.to_owned())
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

fn server_request(id: RequestId, method: &str, params: Value) -> Message {
    Message {
        jsonrpc: "2.0".to_owned(),
        id: Some(id),
        method: Some(method.to_owned()),
        params: Some(params),
        result: None,
        error: None,
    }
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
        let readiness = router.drain_notifications();
        assert!(
            readiness
                .iter()
                .any(|message| message.method.as_deref() == Some("loadingBar"))
        );
        assert!(
            readiness
                .iter()
                .any(|message| message.method.as_deref() == Some("debugBar"))
        );
        assert!(
            readiness
                .iter()
                .any(|message| message.method.as_deref() == Some("cwtools/serverReady"))
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
    fn consumes_initialization_options_and_workspace_folders() {
        let mut router = Router::default();
        let response = router
            .route(&request(1, "initialize", json!({
                "rootUri": "file:///root",
                "workspaceFolders": [
                    {"uri":"file:///a","name":"A"},
                    {"uri":"file:///b","name":"B"}
                ],
                "initializationOptions": {
                    "language": "stellaris",
                    "uiLanguage": "zh-cn",
                    "isVanillaFolder": true,
                    "rulesCache": "file:///cache",
                    "rules_version": "v1",
                    "diagnosticLogging": true
                },
                "capabilities": {
                    "textDocument": {"completion": {"completionItem": {"insertReplaceSupport": true}}},
                    "workspace": {"didChangeWatchedFiles": {"dynamicRegistration": true}}
                }
            })))
            .expect("initialize response");
        assert!(response.result.is_some());
    }

    #[test]
    fn correlates_bounded_apply_edit_reverse_request() {
        let mut router = Router::default();
        assert!(router.request_apply_edit(Some("rename"), json!({"changes":{}})));
        let outgoing = router.drain_outgoing();
        assert_eq!(outgoing.len(), 1);
        assert_eq!(outgoing[0].method.as_deref(), Some("workspace/applyEdit"));
        let id = outgoing[0].id.clone().expect("reverse request id");
        assert_eq!(router.pending_reverse_count(), 1);
        assert!(
            router
                .route(&Message {
                    jsonrpc: "2.0".to_owned(),
                    id: Some(id),
                    method: None,
                    params: None,
                    result: Some(json!({"applied":true})),
                    error: None,
                })
                .is_none()
        );
        assert_eq!(router.pending_reverse_count(), 0);
    }

    #[test]
    fn read_only_router_rejects_write_commands() {
        let mut router = Router::with_read_only(true);
        assert!(router.route(&request(1, "initialize", json!({}))).is_some());
        assert!(
            router
                .route(&notification("initialized", json!({})))
                .is_none()
        );
        let response = router
            .route(&request(
                2,
                "workspace/executeCommand",
                json!({
                    "command": "cacheVanilla", "arguments": []
                }),
            ))
            .expect("read-only error");
        assert_eq!(response.error.expect("error").code, -32_603);
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
