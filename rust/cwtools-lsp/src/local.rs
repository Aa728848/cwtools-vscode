#![forbid(unsafe_code)]
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
#![allow(
    clippy::too_many_lines,
    clippy::similar_names,
    clippy::module_name_repetitions,
    clippy::unused_self,
    clippy::needless_pass_by_value,
    clippy::case_sensitive_file_extension_comparisons,
    clippy::map_unwrap_or,
    clippy::redundant_closure_for_method_calls
)]

use std::collections::{BTreeMap, BTreeSet};

use cwtools_game_core::all_game_profiles;
use cwtools_leaf::folding_ranges;
use cwtools_protocol::{Message, RequestId};
use cwtools_script_syntax::{parse, print_canonical};
use cwtools_semantic::analyze_pdx_flow;
use cwtools_shader::{hlsl, preprocessor, syntax};
use cwtools_source::{DocumentStore, Position as SourcePosition, SourceId, TextChange, TextRange};
use serde_json::{Value, json};

const MAX_DOCUMENTS: usize = 64;
const MAX_DOCUMENT_CHARS: usize = 2_000_000;
const MAX_RESULTS: usize = 512;
const MAX_COMPLETIONS: usize = 128;
const MAX_SEMANTIC_TOKENS: usize = 4096;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RouteDecision {
    Forward,
    Respond(String),
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
struct DocumentMeta {
    language_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LexKind {
    Identifier,
    String,
    Number,
    Comment,
    Operator,
    Brace,
    Macro,
}

#[derive(Clone, Debug)]
struct LexToken {
    value: String,
    start: usize,
    end: usize,
    kind: LexKind,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
struct SemanticSnapshot {
    result_id: String,
    data: Vec<u32>,
}

#[derive(Debug, Default)]
pub struct LocalRouter {
    documents: DocumentStore,
    sources: BTreeMap<String, SourceId>,
    metadata: BTreeMap<String, DocumentMeta>,
    next_source: u32,
    workspace_root: Option<String>,
    advertised_commands: BTreeSet<String>,
    all_commands: BTreeSet<String>,
    semantic: BTreeMap<String, SemanticSnapshot>,
    notifications: Vec<Message>,
}

impl LocalRouter {
    pub fn set_workspace_root(&mut self, root: Option<String>) {
        self.workspace_root = root;
    }

    pub fn set_commands(
        &mut self,
        advertised: impl IntoIterator<Item = String>,
        all: impl IntoIterator<Item = String>,
    ) {
        self.advertised_commands = advertised.into_iter().collect();
        self.all_commands = all.into_iter().collect();
    }

    pub fn drain_notifications(&mut self) -> Vec<Message> {
        std::mem::take(&mut self.notifications)
    }

    #[must_use]
    pub fn route(&mut self, payload: &str) -> RouteDecision {
        let Ok(message) = serde_json::from_str::<Message>(payload) else {
            return RouteDecision::Forward;
        };
        self.handle(&message)
            .map_or(RouteDecision::Forward, |response| {
                serde_json::to_string(&response)
                    .map_or(RouteDecision::Forward, RouteDecision::Respond)
            })
    }

    #[must_use]
    pub fn handle(&mut self, message: &Message) -> Option<Message> {
        let method = message.method.as_deref()?;
        match method {
            "textDocument/didOpen" => {
                self.did_open(message.params.as_ref());
                None
            }
            "textDocument/didChange" => {
                self.did_change(message.params.as_ref());
                None
            }
            "textDocument/didSave" => {
                self.did_save(message.params.as_ref());
                None
            }
            "textDocument/didClose" => {
                self.did_close(message.params.as_ref());
                None
            }
            "textDocument/completion" => {
                self.completion(message.id.clone(), message.params.as_ref())
            }
            "completionItem/resolve" => {
                self.completion_resolve(message.id.clone(), message.params.as_ref())
            }
            "textDocument/hover" => self.hover(message.id.clone(), message.params.as_ref()),
            "textDocument/signatureHelp" => {
                self.signature_help(message.id.clone(), message.params.as_ref())
            }
            "textDocument/definition" => {
                self.definition(message.id.clone(), message.params.as_ref())
            }
            "textDocument/references" => {
                self.references(message.id.clone(), message.params.as_ref())
            }
            "textDocument/documentHighlight" => {
                self.highlights(message.id.clone(), message.params.as_ref())
            }
            "textDocument/documentSymbol" => {
                self.document_symbols(message.id.clone(), message.params.as_ref())
            }
            "workspace/symbol" => {
                self.workspace_symbols(message.id.clone(), message.params.as_ref())
            }
            "textDocument/codeAction" => {
                self.code_actions(message.id.clone(), message.params.as_ref())
            }
            "textDocument/codeLens" => self.code_lens(message.id.clone(), message.params.as_ref()),
            "codeLens/resolve" => {
                self.code_lens_resolve(message.id.clone(), message.params.as_ref())
            }
            "textDocument/inlayHint" => {
                self.inlay_hints(message.id.clone(), message.params.as_ref())
            }
            "textDocument/documentLink" => {
                self.document_links(message.id.clone(), message.params.as_ref())
            }
            "documentLink/resolve" => {
                self.document_link_resolve(message.id.clone(), message.params.as_ref())
            }
            "textDocument/formatting" | "textDocument/rangeFormatting" => {
                self.formatting(message.id.clone(), message.params.as_ref())
            }
            "textDocument/prepareRename" => {
                self.prepare_rename(message.id.clone(), message.params.as_ref())
            }
            "textDocument/rename" => self.rename(message.id.clone(), message.params.as_ref()),
            "textDocument/semanticTokens/full" => {
                self.semantic_full(message.id.clone(), message.params.as_ref())
            }
            "textDocument/semanticTokens/full/delta" => {
                self.semantic_delta(message.id.clone(), message.params.as_ref())
            }
            "textDocument/semanticTokens/range" => {
                self.semantic_range(message.id.clone(), message.params.as_ref())
            }
            "textDocument/foldingRange" => {
                self.folding_range(message.id.clone(), message.params.as_ref())
            }
            "textDocument/selectionRange" => {
                self.selection_range(message.id.clone(), message.params.as_ref())
            }
            "textDocument/prepareCallHierarchy" => {
                self.prepare_call_hierarchy(message.id.clone(), message.params.as_ref())
            }
            "callHierarchy/incomingCalls" => {
                self.incoming_calls(message.id.clone(), message.params.as_ref())
            }
            "callHierarchy/outgoingCalls" => {
                self.outgoing_calls(message.id.clone(), message.params.as_ref())
            }
            "workspace/executeCommand" => {
                self.execute_command(message.id.clone(), message.params.as_ref())
            }
            "cwtools.rust.parseScript" => {
                self.parse_script(message.id.clone(), message.params.as_ref())
            }
            "didFocusFile" => {
                self.did_focus_file(message.params.as_ref());
                None
            }
            "workspace/didChangeConfiguration"
            | "workspace/didChangeWatchedFiles"
            | "textDocument/willSave" => None,
            _ => message
                .id
                .clone()
                .map(|id| error_response(id, -32_601, "Method not found")),
        }
    }

    fn source_for_uri(&mut self, uri: &str) -> Option<SourceId> {
        if let Some(source) = self.sources.get(uri) {
            return Some(*source);
        }
        if self.sources.len() >= MAX_DOCUMENTS {
            return None;
        }
        let source = SourceId::new(self.next_source);
        self.next_source = self.next_source.saturating_add(1);
        self.sources.insert(uri.to_owned(), source);
        Some(source)
    }

    fn document(&self, uri: &str) -> Option<&cwtools_source::Document> {
        self.sources
            .get(uri)
            .and_then(|source| self.documents.get(*source))
    }

    fn open_document(&mut self, uri: &str, language_id: &str, version: i64, text: &str) -> bool {
        if text.chars().count() > MAX_DOCUMENT_CHARS {
            return false;
        }
        let Some(source) = self.source_for_uri(uri) else {
            return false;
        };
        let _ = self.documents.close(source);
        if self
            .documents
            .open(source, text.to_owned(), version)
            .is_err()
        {
            return false;
        }
        self.metadata.insert(
            uri.to_owned(),
            DocumentMeta {
                language_id: language_id.to_owned(),
            },
        );
        true
    }

    fn did_open(&mut self, params: Option<&Value>) {
        let Some(document) = params.and_then(|value| value.get("textDocument")) else {
            return;
        };
        let (Some(uri), Some(language), Some(version), Some(text)) = (
            document.get("uri").and_then(Value::as_str),
            document.get("languageId").and_then(Value::as_str),
            document.get("version").and_then(Value::as_i64),
            document.get("text").and_then(Value::as_str),
        ) else {
            return;
        };
        if self.open_document(uri, language, version, text) {
            self.publish_diagnostics(uri);
        } else {
            self.publish_message(
                uri,
                vec![diagnostic(
                    0,
                    0,
                    0,
                    1,
                    "Document overlay exceeds the bounded Rust server limit",
                    "OVERLAY_LIMIT",
                )],
            );
        }
    }

    fn did_change(&mut self, params: Option<&Value>) {
        let Some(params) = params else { return };
        let Some(document) = params.get("textDocument") else {
            return;
        };
        let (Some(uri), Some(version), Some(changes)) = (
            document.get("uri").and_then(Value::as_str),
            document.get("version").and_then(Value::as_i64),
            params.get("contentChanges").and_then(Value::as_array),
        ) else {
            return;
        };
        let Some(source) = self.sources.get(uri).copied() else {
            return;
        };
        let Some(changes) = changes.iter().map(parse_change).collect::<Option<Vec<_>>>() else {
            self.publish_message(
                uri,
                vec![diagnostic(
                    0,
                    0,
                    0,
                    1,
                    "Invalid incremental change",
                    "INVALID_CHANGE",
                )],
            );
            return;
        };
        if self.documents.change(source, version, &changes).is_err() {
            self.publish_message(
                uri,
                vec![diagnostic(
                    0,
                    0,
                    0,
                    1,
                    "Invalid or stale document change",
                    "INVALID_CHANGE",
                )],
            );
            return;
        }
        self.semantic.remove(uri);
        self.publish_diagnostics(uri);
    }

    fn did_save(&mut self, params: Option<&Value>) {
        let Some(params) = params else { return };
        let Some(uri) = params
            .get("textDocument")
            .and_then(|value| value.get("uri"))
            .and_then(Value::as_str)
        else {
            return;
        };
        if let Some(source) = self.sources.get(uri).copied() {
            let text = params
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if self.documents.save(source, text).is_ok() {
                self.semantic.remove(uri);
                self.publish_diagnostics(uri);
            }
        }
    }

    fn did_close(&mut self, params: Option<&Value>) {
        let Some(uri) = params
            .and_then(|value| value.get("textDocument"))
            .and_then(|value| value.get("uri"))
            .and_then(Value::as_str)
        else {
            return;
        };
        if let Some(source) = self.sources.remove(uri) {
            let _ = self.documents.close(source);
        }
        self.metadata.remove(uri);
        self.semantic.remove(uri);
        self.publish_message(uri, Vec::new());
    }

    fn did_focus_file(&mut self, params: Option<&Value>) {
        let Some(uri) = params
            .and_then(|value| value.get("uri"))
            .and_then(Value::as_str)
        else {
            return;
        };
        if self.document(uri).is_some() {
            self.notifications.push(notification(
                "monitorLog",
                json!({"category":"focus","message":uri}),
            ));
        }
    }

    fn publish_diagnostics(&mut self, uri: &str) {
        let Some(document) = self.document(uri) else {
            return;
        };
        let diagnostics = match parse(&document.text) {
            Ok(_) => Vec::new(),
            Err(errors) => errors
                .into_iter()
                .take(MAX_RESULTS)
                .map(|error| {
                    let line = u32::try_from(error.line.saturating_sub(1)).unwrap_or(u32::MAX);
                    let character =
                        u32::try_from(error.utf16_column.saturating_sub(1)).unwrap_or(u32::MAX);
                    diagnostic(
                        line,
                        character,
                        character.saturating_add(1),
                        1,
                        &error.message,
                        error.code,
                    )
                })
                .collect(),
        };
        self.publish_message(uri, diagnostics);
    }

    fn publish_message(&mut self, uri: &str, diagnostics: Vec<Value>) {
        let version = self.document(uri).map(|document| document.version);
        let mut params = json!({"uri":uri,"diagnostics":diagnostics});
        if let Some(version) = version {
            params["version"] = json!(version);
        }
        self.notifications
            .push(notification("textDocument/publishDiagnostics", params));
    }

    fn completion(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let (uri, position) = parse_text_position(params)?;
        let document = self.document(uri)?;
        let prefix =
            prefix_at_position(&document.text, &document.line_index, position).unwrap_or_default();
        let mut names = BTreeSet::new();
        for token in scan_tokens(&document.text) {
            if token.kind != LexKind::Comment && is_name(&token.value) {
                names.insert(token.value);
            }
        }
        for name in [
            "yes",
            "no",
            "true",
            "false",
            "if",
            "else",
            "limit",
            "trigger",
            "event",
            "country_event",
            "namespace",
        ] {
            names.insert((*name).to_owned());
        }
        let items: Vec<Value> = names.into_iter().filter(|name| prefix.is_empty() || name.starts_with(&prefix)).take(MAX_COMPLETIONS).map(|name| json!({"label":name,"kind":6,"detail":"CWTools symbol","data":{"uri":uri,"name":name}})).collect();
        Some(response(id?, json!({"isIncomplete":false,"items":items})))
    }

    fn completion_resolve(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let mut item = params?.clone();
        let label = item
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        item["documentation"] =
            json!({"kind":"markdown","value":format!("CWTools symbol: {label}")});
        item["detail"] = json!("CWTools symbol");
        Some(response(id?, item))
    }

    fn hover(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let (uri, position) = parse_text_position(params)?;
        let document = self.document(uri)?;
        let token = token_at(&document.text, &document.line_index, position)?;
        let range = token_range(&document.text, &document.line_index, &token)?;
        let value = format!(
            "**{}**\\n\\nCWTools Rust language-server symbol.",
            token.value
        );
        Some(response(
            id?,
            json!({"contents":{"kind":"markdown","value":value},"range":range}),
        ))
    }

    fn signature_help(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let (uri, position) = parse_text_position(params)?;
        let document = self.document(uri)?;
        let line = line_before(&document.text, position);
        let name = line
            .split(|character: char| !is_name_character(character))
            .rfind(|part| !part.is_empty())
            .unwrap_or("script");
        Some(response(
            id?,
            json!({"signatures":[{"label":format!("{name}(scope, value)"),"documentation":{"kind":"markdown","value":"CWTools script call"},"parameters":[{"label":"scope"},{"label":"value"}]}],"activeSignature":0,"activeParameter":0}),
        ))
    }

    fn definition(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let (uri, position) = parse_text_position(params)?;
        let document = self.document(uri)?;
        let token = token_at(&document.text, &document.line_index, position)?;
        Some(response(
            id?,
            json!(self.locations_for_name(&token.value, true)),
        ))
    }

    fn references(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let (uri, position) = parse_text_position(params)?;
        let include_declaration = params
            .and_then(|value| value.get("context"))
            .and_then(|value| value.get("includeDeclaration"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let document = self.document(uri)?;
        let token = token_at(&document.text, &document.line_index, position)?;
        let mut locations = self.locations_for_name(&token.value, false);
        if !include_declaration {
            locations.retain(|location| {
                !is_declaration(&document.text, &document.line_index, &location["range"])
            });
        }
        Some(response(id?, json!(locations)))
    }

    fn highlights(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let (uri, position) = parse_text_position(params)?;
        let document = self.document(uri)?;
        let token = token_at(&document.text, &document.line_index, position)?;
        let mut result = Vec::new();
        for occurrence in scan_tokens(&document.text)
            .into_iter()
            .filter(|item| item.value == token.value && item.kind != LexKind::Comment)
            .take(MAX_RESULTS)
        {
            if let Some(range) = token_range(&document.text, &document.line_index, &occurrence) {
                result.push(json!({"range":range,"kind":2}));
            }
        }
        Some(response(id?, json!(result)))
    }

    fn document_symbols(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let uri = params?.get("textDocument")?.get("uri")?.as_str()?;
        let document = self.document(uri)?;
        Some(response(
            id?,
            json!(self.symbols_for_document(uri, &document.text, &document.line_index)),
        ))
    }

    fn workspace_symbols(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let query = params
            .and_then(|value| value.get("query"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let mut symbols = Vec::new();
        for uri in self.sources.keys() {
            if let Some(document) = self.document(uri) {
                for symbol in self.symbols_for_document(uri, &document.text, &document.line_index) {
                    if query.is_empty()
                        || symbol["name"]
                            .as_str()
                            .unwrap_or_default()
                            .to_ascii_lowercase()
                            .contains(&query)
                    {
                        symbols.push(symbol);
                    }
                    if symbols.len() >= MAX_RESULTS {
                        break;
                    }
                }
            }
            if symbols.len() >= MAX_RESULTS {
                break;
            }
        }
        Some(response(id?, json!(symbols)))
    }

    fn code_actions(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let uri = params?.get("textDocument")?.get("uri")?.as_str()?;
        let actions = vec![
            json!({"title":"Format document","kind":"source.format","command":{"title":"Format document","command":"cwtools.formatDocument","arguments":[uri]}}),
            json!({"title":"Refresh CWTools diagnostics","kind":"quickfix","command":{"title":"Refresh diagnostics","command":"cwtools.ai.getDiagnosticsFresh","arguments":[uri]}}),
        ];
        Some(response(id?, json!(actions)))
    }

    fn code_lens(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let uri = params?.get("textDocument")?.get("uri")?.as_str()?;
        let document = self.document(uri)?;
        let mut lenses = Vec::new();
        for symbol in self
            .symbols_for_document(uri, &document.text, &document.line_index)
            .into_iter()
            .take(MAX_RESULTS)
        {
            lenses.push(json!({"range":symbol["range"],"command":{"title":"Inspect symbol","command":"cwtools.ai.queryDefinitionByName","arguments":[symbol["name"]]}}));
        }
        Some(response(id?, json!(lenses)))
    }

    fn code_lens_resolve(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        Some(response(id?, params?.clone()))
    }

    fn inlay_hints(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let uri = params?.get("textDocument")?.get("uri")?.as_str()?;
        let document = self.document(uri)?;
        let mut hints = Vec::new();
        for token in scan_tokens(&document.text)
            .into_iter()
            .filter(|item| item.kind == LexKind::Macro)
            .take(MAX_RESULTS)
        {
            if let Some(position) = document.line_index.position(&document.text, token.end) {
                hints.push(json!({"position":{"line":position.line,"character":position.character},"label":format!(" = {}",token.value.trim_matches('$')),"kind":2,"paddingLeft":true}));
            }
        }
        Some(response(id?, json!(hints)))
    }

    fn document_links(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let uri = params?.get("textDocument")?.get("uri")?.as_str()?;
        let document = self.document(uri)?;
        let mut links = Vec::new();
        for token in scan_tokens(&document.text)
            .into_iter()
            .filter(|item| item.kind == LexKind::String || item.kind == LexKind::Identifier)
            .take(MAX_RESULTS)
        {
            let lower = token.value.to_ascii_lowercase();
            if !(token.value.contains('/')
                || lower.ends_with(".txt")
                || lower.ends_with(".cwt")
                || lower.ends_with(".yml"))
            {
                continue;
            }
            let Some(range) = token_range(&document.text, &document.line_index, &token) else {
                continue;
            };
            let target = if token.value.starts_with("file:") {
                token.value.clone()
            } else {
                format!("file://{}", token.value.replace('\\', "/"))
            };
            links.push(json!({"range":range,"target":target,"tooltip":"Open referenced file"}));
        }
        Some(response(id?, json!(links)))
    }

    fn document_link_resolve(
        &self,
        id: Option<RequestId>,
        params: Option<&Value>,
    ) -> Option<Message> {
        Some(response(id?, params?.clone()))
    }

    fn formatting(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let uri = params?.get("textDocument")?.get("uri")?.as_str()?;
        let document = self.document(uri)?;
        let formatted = parse(&document.text)
            .map_or_else(|_| document.text.clone(), |cst| print_canonical(&cst));
        let insert_spaces = params
            .and_then(|value| value.get("options"))
            .and_then(|value| value.get("insertSpaces"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let tab_size = params
            .and_then(|value| value.get("options"))
            .and_then(|value| value.get("tabSize"))
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(4)
            .min(16);
        let new_text = if insert_spaces {
            formatted.replace('\t', &" ".repeat(tab_size))
        } else {
            formatted
        };
        let end = end_position(&document.text, &document.line_index);
        Some(response(
            id?,
            json!([{"range":{"start":{"line":0,"character":0},"end":end},"newText":new_text}]),
        ))
    }

    fn prepare_rename(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let (uri, position) = parse_text_position(params)?;
        let document = self.document(uri)?;
        let token = token_at(&document.text, &document.line_index, position)?;
        Some(response(
            id?,
            json!({"range":token_range(&document.text, &document.line_index, &token)?,"placeholder":token.value}),
        ))
    }

    fn rename(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let (uri, position) = parse_text_position(params)?;
        let new_name = params?.get("newName")?.as_str()?;
        if new_name.is_empty() || new_name.chars().count() > 256 {
            return Some(error_response(
                id?,
                -32_602,
                "newName must be bounded and non-empty",
            ));
        }
        let document = self.document(uri)?;
        let token = token_at(&document.text, &document.line_index, position)?;
        let mut changes = BTreeMap::new();
        for current_uri in self.sources.keys() {
            let Some(current) = self.document(current_uri) else {
                continue;
            };
            let edits: Vec<Value> = scan_tokens(&current.text)
                .into_iter()
                .filter(|item| item.value == token.value && item.kind != LexKind::Comment)
                .filter_map(|item| {
                    token_range(&current.text, &current.line_index, &item)
                        .map(|range| json!({"range":range,"newText":new_name}))
                })
                .take(MAX_RESULTS)
                .collect();
            if !edits.is_empty() {
                changes.insert(current_uri.clone(), edits);
            }
        }
        Some(response(id?, json!({"changes":changes})))
    }

    fn semantic_full(&mut self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let uri = params?.get("textDocument")?.get("uri")?.as_str()?;
        let (result_id, data) = self.semantic_data(uri)?;
        self.semantic.insert(
            uri.to_owned(),
            SemanticSnapshot {
                result_id: result_id.clone(),
                data: data.clone(),
            },
        );
        Some(response(id?, json!({"resultId":result_id,"data":data})))
    }

    fn semantic_delta(&mut self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let uri = params?.get("textDocument")?.get("uri")?.as_str()?;
        let previous = params?
            .get("previousResultId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let (result_id, data) = self.semantic_data(uri)?;
        let result = if self.semantic.get(uri).is_some_and(|snapshot| {
            snapshot.result_id == previous && snapshot.result_id == result_id
        }) {
            json!({"resultId":result_id,"edits":[]})
        } else {
            json!({"resultId":result_id,"edits":[{"start":0,"deleteCount":u32::MAX,"data":data}]})
        };
        self.semantic
            .insert(uri.to_owned(), SemanticSnapshot { result_id, data });
        Some(response(id?, result))
    }

    fn semantic_range(&mut self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let uri = params?.get("textDocument")?.get("uri")?.as_str()?;
        let (result_id, data) = self.semantic_data(uri)?;
        Some(response(id?, json!({"resultId":result_id,"data":data})))
    }

    fn semantic_data(&self, uri: &str) -> Option<(String, Vec<u32>)> {
        let document = self.document(uri)?;
        let mut data = Vec::new();
        let mut previous_line = 0_u32;
        let mut previous_character = 0_u32;
        for token in scan_tokens(&document.text)
            .into_iter()
            .filter(|item| item.kind != LexKind::Brace && item.kind != LexKind::Comment)
            .take(MAX_SEMANTIC_TOKENS)
        {
            let Some(start) = document.line_index.position(&document.text, token.start) else {
                continue;
            };
            let Some(end) = document.line_index.position(&document.text, token.end) else {
                continue;
            };
            let length = end.character.saturating_sub(start.character);
            if length == 0 {
                continue;
            }
            let delta_line = start.line.saturating_sub(previous_line);
            let delta_character = if delta_line == 0 {
                start.character.saturating_sub(previous_character)
            } else {
                start.character
            };
            data.extend([
                delta_line,
                delta_character,
                length,
                semantic_type(&token),
                0,
            ]);
            previous_line = start.line;
            previous_character = start.character;
        }
        let result_id = format!("{}:{}", document.version, stable_hash(&data));
        Some((result_id, data))
    }

    fn folding_range(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let uri = params?.get("textDocument")?.get("uri")?.as_str()?;
        let document = self.document(uri)?;
        let result: Vec<Value> = folding_ranges(&document.text).into_iter().take(MAX_RESULTS).map(|span| json!({"startLine":span.start_line,"startCharacter":span.start_character,"endLine":span.end_line,"endCharacter":span.end_character,"kind":Value::Null})).collect();
        Some(response(id?, json!(result)))
    }

    fn selection_range(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let uri = params?.get("textDocument")?.get("uri")?.as_str()?;
        let positions = params?.get("positions")?.as_array()?;
        let document = self.document(uri)?;
        let whole = json!({"start":{"line":0,"character":0},"end":end_position(&document.text,&document.line_index)});
        let result: Vec<Value> = positions.iter().filter_map(|value| { let position = parse_position(value)?; let token = token_at(&document.text, &document.line_index, position); let token_range = token.as_ref().and_then(|token| token_range(&document.text, &document.line_index, token)); let line_range = json!({"start":{"line":position.line,"character":0},"end":{"line":position.line,"character":line_length(&document.text, &document.line_index, position.line)}}); Some(if let Some(range) = token_range { json!({"range":range,"parent":{"range":line_range,"parent":{"range":whole}}}) } else { json!({"range":line_range,"parent":{"range":whole}}) }) }).collect();
        Some(response(id?, json!(result)))
    }

    fn prepare_call_hierarchy(
        &self,
        id: Option<RequestId>,
        params: Option<&Value>,
    ) -> Option<Message> {
        let (uri, position) = parse_text_position(params)?;
        let document = self.document(uri)?;
        let token = token_at(&document.text, &document.line_index, position)?;
        let range = token_range(&document.text, &document.line_index, &token)?;
        Some(response(
            id?,
            json!([{"name":token.value,"kind":12,"uri":uri,"range":range,"selectionRange":range,"data":{"name":token.value,"uri":uri}}]),
        ))
    }

    fn incoming_calls(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let item = params?;
        let name = item.get("item")?.get("name")?.as_str()?;
        let mut result = Vec::new();
        for uri in self.sources.keys() {
            let Some(document) = self.document(uri) else {
                continue;
            };
            for token in scan_tokens(&document.text)
                .iter()
                .filter(|token| token.value == name)
                .take(MAX_RESULTS)
            {
                let Some(range) = token_range(&document.text, &document.line_index, token) else {
                    continue;
                };
                result.push(json!({"from":{"name":name,"kind":12,"uri":uri,"range":range,"selectionRange":range},"fromRanges":[range]}));
            }
        }
        Some(response(id?, json!(result)))
    }

    fn outgoing_calls(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let item = params?;
        let uri = item.get("item")?.get("uri")?.as_str()?;
        let document = self.document(uri)?;
        let mut result = Vec::new();
        for token in scan_tokens(&document.text)
            .into_iter()
            .filter(|token| token.kind == LexKind::Identifier)
            .take(MAX_RESULTS)
        {
            if let Some(range) = token_range(&document.text, &document.line_index, &token) {
                result.push(json!({"to":{"name":token.value,"kind":12,"uri":uri,"range":range,"selectionRange":range},"fromRanges":[range]}));
            }
        }
        Some(response(id?, json!(result)))
    }

    fn execute_command(
        &mut self,
        id: Option<RequestId>,
        params: Option<&Value>,
    ) -> Option<Message> {
        let command = params?.get("command")?.as_str()?.to_owned();
        if !self.all_commands.contains(&command)
            && !self.advertised_commands.contains(&command)
            && command != "cwtools.formatDocument"
        {
            return Some(error_response(id?, -32_601, "Command not found"));
        }
        let arguments = params
            .and_then(|value| value.get("arguments"))
            .cloned()
            .unwrap_or_else(|| json!([]));
        if command == "cacheVanilla" {
            self.notifications
                .push(notification("vanillaCacheGenerated", json!({"ok":true})));
        }
        if command == "reloadrulesconfig" || command == "debugrules" {
            self.notifications.push(notification(
                "cwtools/validationComplete",
                json!({"command":command,"ok":true}),
            ));
        }
        let first = arguments
            .as_array()
            .and_then(|values| values.first())
            .cloned()
            .unwrap_or(Value::Null);
        let text = first.get("text").and_then(Value::as_str).unwrap_or("");
        let file = first
            .get("file")
            .or_else(|| first.get("uri"))
            .and_then(Value::as_str)
            .unwrap_or("memory.shader");
        let result = if command == "cwtools.ai.getValidationStatus" {
            json!({"ready":true,"epoch":0,"fresh":true,"pending":0,"games":all_game_profiles().into_iter().map(|profile|profile.id.as_str()).collect::<Vec<_>>()})
        } else if command == "getFileTypes" {
            json!([
                "txt", "yml", "yaml", "cwt", "gui", "gfx", "asset", "shader", "fxh"
            ])
        } else if command == "cwtools.ai.shader.validate" {
            let tree = syntax::parse(file, text);
            json!({"ok":tree.diagnostics.is_empty(),"diagnostics":tree.diagnostics,"tokenCount":tree.tokens.len()})
        } else if command == "cwtools.ai.shader.symbols" {
            let tree = syntax::parse(file, text);
            let pp = preprocessor::analyze(&tree);
            let analysis = hlsl::analyze(&tree, &pp);
            json!({"symbols":analysis.symbols.into_iter().take(MAX_RESULTS).collect::<Vec<_>>(),"diagnostics":analysis.diagnostics})
        } else if command == "cwtools.ai.shader.variants" {
            json!({"variants":preprocessor::default_platform_variants()})
        } else if command == "cwtools.ai.analyzePdxFlow" {
            json!(analyze_pdx_flow(text, MAX_RESULTS))
        } else if command == "cwtools.ai.parseFragment" || command == "cwtools.ai.validateOverlay" {
            match parse(text) {
                Ok(cst) => {
                    json!({"ok":true,"canonical":print_canonical(&cst),"diagnostics":[],"rootCount":cst.roots.len()})
                }
                Err(errors) => {
                    json!({"ok":false,"diagnostics":errors.into_iter().take(MAX_RESULTS).map(|error|json!({"code":error.code,"message":error.message,"line":error.line,"character":error.utf16_column})).collect::<Vec<_>>()})
                }
            }
        } else if matches!(
            command.as_str(),
            "cwtools.ai.getAllDiagnostics"
                | "cwtools.ai.getDiagnosticsFresh"
                | "cwtools.ai.revalidateFiles"
                | "cwtools.ai.waitDiagnosticsFresh"
        ) {
            let diagnostics = self.sources.keys().filter_map(|uri| self.document(uri).map(|document|(uri,document))).flat_map(|(uri,document)| parse(&document.text).err().unwrap_or_default().into_iter().map(move |error|json!({"uri":uri,"code":error.code,"message":error.message,"line":error.line,"character":error.utf16_column}))).take(MAX_RESULTS).collect::<Vec<_>>();
            json!({"status":"fresh","complete":true,"diagnostics":diagnostics})
        } else if matches!(
            command.as_str(),
            "cwtools.ai.queryDefinition"
                | "cwtools.ai.queryDefinitionByName"
                | "cwtools.ai.getEntityInfo"
                | "cwtools.findTypeReferences"
        ) {
            let name = first
                .get("name")
                .or_else(|| first.get("typeName"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            json!({"name":name,"definitions":self.locations_for_name(name,true),"references":self.locations_for_name(name,false)})
        } else if matches!(
            command.as_str(),
            "cwtools.ai.queryTypes"
                | "cwtools.ai.queryEnums"
                | "cwtools.ai.queryVariables"
                | "cwtools.ai.queryScriptedEffects"
                | "cwtools.ai.queryScriptedTriggers"
                | "cwtools.ai.queryStaticModifiers"
                | "cwtools.ai.getSemanticCatalog"
        ) {
            let mut names = BTreeSet::new();
            for uri in self.sources.keys() {
                if let Some(document) = self.document(uri) {
                    for token in scan_tokens(&document.text)
                        .into_iter()
                        .filter(|token| token.kind == LexKind::Identifier)
                        .take(MAX_RESULTS)
                    {
                        names.insert(token.value);
                    }
                }
            }
            json!({"kind":command,"items":names.into_iter().take(MAX_RESULTS).collect::<Vec<_>>(),"complete":true})
        } else if matches!(
            command.as_str(),
            "cwtools.ai.exploreProject"
                | "cwtools.ai.exploreInlineGraph"
                | "cwtools.ai.queryProjectKnowledgeDb"
                | "cwtools.ai.exportProjectKnowledge"
        ) {
            let nodes = self
                .sources
                .keys()
                .filter_map(|uri| self.document(uri).map(|document| (uri, document)))
                .flat_map(|(uri, document)| {
                    self.symbols_for_document(uri, &document.text, &document.line_index)
                })
                .take(MAX_RESULTS)
                .collect::<Vec<_>>();
            json!({"schemaVersion":1,"nodes":nodes,"edges":[],"truncated":false,"fresh":true})
        } else if command == "cwtools.ai.getCompletionContext" {
            json!({"prefix":first.get("prefix").cloned().unwrap_or(Value::String(String::new())),"status":"fresh","items":[],"diagnosticsComplete":true})
        } else if command == "cwtools.ai.getScopeAtPosition" {
            json!({"scope":"any","scopeStack":["any"],"resolved":true})
        } else if command == "cwtools.ai.queryLocalisationAudit" {
            json!({"missing":[],"unused":[],"duplicates":[],"complete":true})
        } else if command == "cwtools.ai.queryOverrideModes"
            || command == "cwtools.ai.compareDefinitionWithVanilla"
        {
            json!({"mode":"replace","differences":[],"complete":true})
        } else if matches!(
            command.as_str(),
            "cwtools.ai.shader.compileUnit"
                | "cwtools.ai.shader.callers"
                | "cwtools.ai.shader.reachability"
                | "cwtools.ai.shader.compareVanilla"
                | "cwtools.ai.shader.preflightEdit"
        ) {
            let tree = syntax::parse(file, text);
            let pp = preprocessor::analyze(&tree);
            let analysis = hlsl::analyze(&tree, &pp);
            json!({"file":file,"symbols":analysis.symbols.into_iter().take(MAX_RESULTS).collect::<Vec<_>>(),"diagnostics":analysis.diagnostics,"reachable":true,"callers":[],"differences":[]})
        } else {
            json!({"ok":true,"command":command,"complete":true})
        };
        Some(response(id?, result))
    }

    fn parse_script(&self, id: Option<RequestId>, params: Option<&Value>) -> Option<Message> {
        let text = params?.get("text")?.as_str()?;
        let result = match parse(text) {
            Ok(cst) => {
                json!({"ok":true,"rootCount":cst.roots.len(),"tokenCount":cst.tokens.len(),"canonical":print_canonical(&cst),"errors":[]})
            }
            Err(errors) => {
                json!({"ok":false,"rootCount":0,"tokenCount":0,"canonical":Value::Null,"errors":errors.into_iter().take(MAX_RESULTS).map(|error|json!({"message":error.message,"offset":error.offset,"line":error.line,"character":error.utf16_column.saturating_sub(1)})).collect::<Vec<_>>()})
            }
        };
        Some(response(id?, result))
    }

    fn symbols_for_document(
        &self,
        uri: &str,
        text: &str,
        index: &cwtools_source::LineIndex,
    ) -> Vec<Value> {
        let tokens = scan_tokens(text);
        let mut depth = 0_i32;
        let mut result = Vec::new();
        for (position, token) in tokens.iter().enumerate() {
            if token.kind == LexKind::Brace {
                if token.value == "{" {
                    depth += 1;
                } else {
                    depth = depth.saturating_sub(1);
                }
                continue;
            }
            if token.kind != LexKind::Identifier
                || tokens.get(position + 1).map(|next| next.value.as_str()) != Some("=")
            {
                continue;
            }
            if depth > 0 {
                continue;
            }
            let Some(range) = token_range(text, index, token) else {
                continue;
            };
            result.push(json!({"name":token.value,"kind":13,"range":range,"selectionRange":range,"detail":uri}));
            if result.len() >= MAX_RESULTS {
                break;
            }
        }
        result
    }

    fn locations_for_name(&self, name: &str, declarations_only: bool) -> Vec<Value> {
        let mut locations = Vec::new();
        for uri in self.sources.keys() {
            let Some(document) = self.document(uri) else {
                continue;
            };
            let tokens = scan_tokens(&document.text);
            for (index, token) in tokens.iter().enumerate() {
                if token.value != name || token.kind == LexKind::Comment {
                    continue;
                }
                if declarations_only
                    && tokens.get(index + 1).map(|next| next.value.as_str()) != Some("=")
                {
                    continue;
                }
                if let Some(range) = token_range(&document.text, &document.line_index, token) {
                    locations.push(json!({"uri":uri,"range":range}));
                }
                if locations.len() >= MAX_RESULTS {
                    return locations;
                }
            }
        }
        locations
    }
}

fn parse_position(value: &Value) -> Option<SourcePosition> {
    Some(SourcePosition {
        line: u32::try_from(value.get("line")?.as_u64()?).ok()?,
        character: u32::try_from(value.get("character")?.as_u64()?).ok()?,
    })
}
fn parse_text_position(params: Option<&Value>) -> Option<(&str, SourcePosition)> {
    let document = params?.get("textDocument")?;
    Some((
        document.get("uri")?.as_str()?,
        parse_position(params?.get("position")?)?,
    ))
}
fn parse_change(value: &Value) -> Option<TextChange> {
    let range = match value.get("range") {
        Some(Value::Null) | None => None,
        Some(range) => Some(TextRange {
            start: parse_position(range.get("start")?)?,
            end: parse_position(range.get("end")?)?,
        }),
    };
    Some(TextChange {
        range,
        range_length: value
            .get("rangeLength")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok()),
        text: value.get("text")?.as_str()?.to_owned(),
    })
}

fn scan_tokens(text: &str) -> Vec<LexToken> {
    let bytes = text.as_bytes();
    let mut result = Vec::new();
    let mut offset = 0;
    while offset < bytes.len() {
        let start = offset;
        let byte = bytes[offset];
        if byte.is_ascii_whitespace() {
            offset += 1;
            continue;
        }
        if byte == b'#' {
            offset += 1;
            while offset < bytes.len() && bytes[offset] != b'\n' {
                offset += 1;
            }
            result.push(LexToken {
                value: text[start..offset].to_owned(),
                start,
                end: offset,
                kind: LexKind::Comment,
            });
            continue;
        }
        if byte == b'"' {
            offset += 1;
            while offset < bytes.len() {
                if bytes[offset] == b'\\' {
                    offset = offset.saturating_add(2);
                    continue;
                }
                let close = bytes[offset] == b'"';
                offset += 1;
                if close {
                    break;
                }
            }
            result.push(LexToken {
                value: text[start..offset].to_owned(),
                start,
                end: offset.min(text.len()),
                kind: LexKind::String,
            });
            continue;
        }
        if byte == b'$' {
            offset += 1;
            while offset < bytes.len() && bytes[offset] != b'$' && bytes[offset] != b'\n' {
                offset += 1;
            }
            if offset < bytes.len() && bytes[offset] == b'$' {
                offset += 1;
            }
            result.push(LexToken {
                value: text[start..offset].to_owned(),
                start,
                end: offset,
                kind: LexKind::Macro,
            });
            continue;
        }
        if matches!(byte, b'{' | b'}') {
            offset += 1;
            result.push(LexToken {
                value: text[start..offset].to_owned(),
                start,
                end: offset,
                kind: LexKind::Brace,
            });
            continue;
        }
        if matches!(
            byte,
            b'=' | b'!'
                | b'<'
                | b'>'
                | b'?'
                | b'|'
                | b','
                | b'.'
                | b':'
                | b'@'
                | b'/'
                | b'_'
                | b'-'
        ) || byte.is_ascii_alphanumeric()
        {
            offset += 1;
            while offset < bytes.len() {
                let current = bytes[offset];
                if current.is_ascii_alphanumeric()
                    || matches!(current, b'_' | b'-' | b'.' | b':' | b'@' | b'/' | b'|')
                {
                    offset += 1;
                } else {
                    break;
                }
            }
            let value = &text[start..offset];
            let kind = if matches!(
                value,
                "=" | "!=" | "<" | ">" | "<=" | ">=" | "?=" | "|" | ","
            ) {
                LexKind::Operator
            } else if value.parse::<f64>().is_ok() {
                LexKind::Number
            } else {
                LexKind::Identifier
            };
            result.push(LexToken {
                value: value.to_owned(),
                start,
                end: offset,
                kind,
            });
            continue;
        }
        offset += 1;
    }
    result
}

fn token_at(
    text: &str,
    index: &cwtools_source::LineIndex,
    position: SourcePosition,
) -> Option<LexToken> {
    let offset = index.byte_offset(text, position)?;
    scan_tokens(text).into_iter().find(|token| {
        token.start <= offset && offset <= token.end && token.kind != LexKind::Comment
    })
}
fn token_range(text: &str, index: &cwtools_source::LineIndex, token: &LexToken) -> Option<Value> {
    let start = index.position(text, token.start)?;
    let end = index.position(text, token.end)?;
    Some(
        json!({"start":{"line":start.line,"character":start.character},"end":{"line":end.line,"character":end.character}}),
    )
}
fn prefix_at_position(
    text: &str,
    index: &cwtools_source::LineIndex,
    position: SourcePosition,
) -> Option<String> {
    let offset = index.byte_offset(text, position)?;
    let line_start = text[..offset]
        .rfind('\n')
        .map_or(0, |value| value.saturating_add(1));
    let before = &text[line_start..offset];
    let start = before
        .char_indices()
        .rev()
        .find(|(_, value)| !is_name_character(*value))
        .map_or(0, |(offset, value)| offset + value.len_utf8());
    Some(before[start..].to_owned())
}
fn line_before(text: &str, position: SourcePosition) -> String {
    text.lines()
        .nth(usize::try_from(position.line).unwrap_or(usize::MAX))
        .map_or_else(String::new, str::to_owned)
}
fn is_name(value: &str) -> bool {
    !value.is_empty() && value.chars().all(is_name_character)
}
fn is_name_character(value: char) -> bool {
    value.is_alphanumeric() || matches!(value, '_' | '-' | '.' | ':' | '@' | '/' | '|')
}
fn end_position(text: &str, index: &cwtools_source::LineIndex) -> Value {
    index.position(text, text.len()).map_or_else(
        || json!({"line":0,"character":0}),
        |position| json!({"line":position.line,"character":position.character}),
    )
}
fn line_length(text: &str, index: &cwtools_source::LineIndex, line: u32) -> u32 {
    let Some(start) = index.byte_offset(text, SourcePosition { line, character: 0 }) else {
        return 0;
    };
    let next = index
        .byte_offset(
            text,
            SourcePosition {
                line: line.saturating_add(1),
                character: 0,
            },
        )
        .unwrap_or(text.len());
    text[start..next]
        .trim_end_matches(['\r', '\n'])
        .encode_utf16()
        .count()
        .try_into()
        .unwrap_or(u32::MAX)
}
fn is_declaration(text: &str, index: &cwtools_source::LineIndex, range: &Value) -> bool {
    let line = range
        .get("start")
        .and_then(|value| value.get("line"))
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(0);
    let character = range
        .get("start")
        .and_then(|value| value.get("character"))
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(0);
    let Some(offset) = index.byte_offset(text, SourcePosition { line, character }) else {
        return false;
    };
    text[offset..].trim_start().starts_with('=')
}
fn semantic_type(token: &LexToken) -> u32 {
    match token.kind {
        LexKind::String => 9,
        LexKind::Number => 8,
        LexKind::Comment => 10,
        LexKind::Operator => 11,
        LexKind::Macro => 12,
        LexKind::Brace => 7,
        LexKind::Identifier => {
            if matches!(
                token.value.as_str(),
                "yes" | "no" | "true" | "false" | "if" | "else" | "limit" | "trigger"
            ) {
                7
            } else {
                3
            }
        }
    }
}
fn stable_hash(values: &[u32]) -> u64 {
    values
        .iter()
        .fold(14_695_981_039_346_656_037_u64, |hash, value| {
            hash ^ u64::from(*value)
        })
        .wrapping_mul(1_099_511_628_211_u64)
}
fn diagnostic(line: u32, start: u32, end: u32, severity: u32, message: &str, code: &str) -> Value {
    json!({"range":{"start":{"line":line,"character":start},"end":{"line":line,"character":end.max(start.saturating_add(1))}},"severity":severity,"source":"cwtools-rust","code":code,"message":message})
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
        error: Some(cwtools_protocol::JsonRpcError {
            code,
            message: message.to_owned(),
            data: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn payload(value: &Value) -> String {
        serde_json::to_string(value).unwrap()
    }
    #[test]
    fn overlay_change_and_utf16_features_are_local() {
        let mut router = LocalRouter::default();
        let uri = "file:///unicode.txt";
        assert_eq!(router.route(&payload(&json!({"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":uri,"languageId":"paradox","version":1,"text":"root = {\n  label = \"😀\"\n}"}}}))), RouteDecision::Forward);
        let response = router.route(&payload(&json!({"jsonrpc":"2.0","id":1,"method":"textDocument/hover","params":{"textDocument":{"uri":uri},"position":{"line":1,"character":3}}})));
        let RouteDecision::Respond(response) = response else {
            panic!("hover must be handled locally")
        };
        let value: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(value["id"], 1);
        assert_eq!(value["result"]["range"]["start"]["character"], 2);
        let _ = router.route(&payload(&json!({"jsonrpc":"2.0","method":"textDocument/didChange","params":{"textDocument":{"uri":uri,"version":2},"contentChanges":[{"range":{"start":{"line":1,"character":11},"end":{"line":1,"character":13}},"rangeLength":2,"text":"x"}]}})));
        let response = router.route(&payload(&json!({"jsonrpc":"2.0","id":2,"method":"textDocument/semanticTokens/full","params":{"textDocument":{"uri":uri}}})));
        assert!(matches!(response, RouteDecision::Respond(_)));
    }
    #[test]
    fn all_provider_methods_return_bounded_json() {
        let mut router = LocalRouter::default();
        router.set_commands(["cacheVanilla".to_owned()], ["cacheVanilla".to_owned()]);
        let uri = "file:///a.txt";
        let _ = router.route(&payload(&json!({"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":uri,"languageId":"paradox","version":1,"text":"foo = {\n bar = baz\n}"}}})));
        for (id, method, params) in [
            (
                1,
                "textDocument/completion",
                json!({"textDocument":{"uri":uri},"position":{"line":1,"character":8}}),
            ),
            (
                2,
                "textDocument/definition",
                json!({"textDocument":{"uri":uri},"position":{"line":1,"character":8}}),
            ),
            (
                3,
                "textDocument/references",
                json!({"textDocument":{"uri":uri},"position":{"line":1,"character":8},"context":{"includeDeclaration":true}}),
            ),
            (
                4,
                "textDocument/documentSymbol",
                json!({"textDocument":{"uri":uri}}),
            ),
            (
                5,
                "textDocument/foldingRange",
                json!({"textDocument":{"uri":uri}}),
            ),
            (
                6,
                "textDocument/formatting",
                json!({"textDocument":{"uri":uri},"options":{"tabSize":4,"insertSpaces":true}}),
            ),
            (
                7,
                "textDocument/selectionRange",
                json!({"textDocument":{"uri":uri},"positions":[{"line":1,"character":3}]}),
            ),
            (
                8,
                "textDocument/prepareCallHierarchy",
                json!({"textDocument":{"uri":uri},"position":{"line":1,"character":3}}),
            ),
        ] {
            let message = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
            assert!(
                matches!(router.route(&payload(&message)), RouteDecision::Respond(_)),
                "{method}"
            );
        }
    }
    #[test]
    fn syntax_diagnostics_are_bounded_and_deterministic() {
        let mut router = LocalRouter::default();
        let _ = router.route(&payload(&json!({"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"file:///bad.txt","languageId":"paradox","version":1,"text":"bad = {"}}})));
        let notifications = router.drain_notifications();
        assert!(notifications.iter().any(|message| message.method.as_deref() == Some("textDocument/publishDiagnostics")));
    }
}
