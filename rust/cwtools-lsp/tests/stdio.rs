use std::io::{Read, Write};
use std::process::{Command, Stdio};

use serde_json::Value;

fn frame(payload: &str) -> Vec<u8> {
    let bytes = payload.as_bytes();
    let mut framed = format!("Content-Length: {}\r\n\r\n", bytes.len()).into_bytes();
    framed.extend_from_slice(bytes);
    framed
}

fn frames(bytes: &[u8]) -> Vec<Value> {
    let mut cursor = 0;
    let mut messages = Vec::new();
    while cursor < bytes.len() {
        let Some(header_end) = bytes[cursor..]
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
        else {
            break;
        };
        let header_end = cursor + header_end;
        let header = std::str::from_utf8(&bytes[cursor..header_end]).expect("UTF-8 headers");
        let length: usize = header
            .strip_prefix("Content-Length: ")
            .expect("content length")
            .parse()
            .expect("numeric length");
        let payload_start = header_end + 4;
        let payload_end = payload_start + length;
        assert!(payload_end <= bytes.len(), "complete payload");
        messages.push(
            serde_json::from_slice(&bytes[payload_start..payload_end]).expect("JSON-RPC payload"),
        );
        cursor = payload_end;
    }
    messages
}

#[test]
fn stdio_process_completes_manifest_lifecycle_without_proxy() {
    let input = [
        frame(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"rootUri":"file:///black-box"}}"#),
        frame(r#"{"jsonrpc":"2.0","method":"initialized","params":{}}"#),
        frame(r#"{"jsonrpc":"2.0","id":2,"method":"shutdown","params":null}"#),
        frame(r#"{"jsonrpc":"2.0","method":"exit","params":null}"#),
    ]
    .concat();
    let mut child = Command::new(env!("CARGO_BIN_EXE_cwtools-lsp"))
        .arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("standalone language server");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(&input)
        .expect("request frames");
    let mut output = Vec::new();
    child
        .stdout
        .take()
        .expect("stdout")
        .read_to_end(&mut output)
        .expect("response frames");
    assert!(child.wait().expect("server exit").success());

    let messages = frames(&output);
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["id"], 1);
    assert!(
        messages[0]["result"]["capabilities"]["hoverProvider"]
            .as_bool()
            .unwrap_or(false)
    );
    assert!(
        messages[0]["result"]["capabilities"]["executeCommandProvider"]["commands"]
            .as_array()
            .unwrap()
            .iter()
            .any(|command| command == "cacheVanilla")
    );
    assert_eq!(messages[1]["id"], 2);
    assert_eq!(messages[1]["result"], Value::Null);
}
