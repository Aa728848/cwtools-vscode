#![forbid(unsafe_code)]

use std::io::{self, BufReader, Write};

use cwtools_lsp::Router;
use cwtools_protocol::Message;
use cwtools_transport::{FrameError, Limits, read_frame, write_frame};

fn run_stdio() -> i32 {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut input = BufReader::new(stdin.lock());
    let mut output = stdout.lock();
    let limits = Limits::default();
    let mut router = Router::default();

    loop {
        let payload = match read_frame(&mut input, limits) {
            Ok(payload) => payload,
            Err(FrameError::Eof) => return 0,
            Err(error) => {
                eprintln!("Controlled transport failure: {error}");
                return 1;
            }
        };
        let message: Message = match serde_json::from_str(&payload) {
            Ok(message) => message,
            Err(error) => {
                eprintln!("Invalid JSON-RPC payload: {error}");
                return 1;
            }
        };
        let is_exit = message.method.as_deref() == Some("exit");
        if let Some(response) = router.route(&message) {
            if let Err(error) = write_message(&mut output, &response, limits) {
                eprintln!("Transport write failure: {error}");
                return 1;
            }
        }
        for notification in router.drain_notifications() {
            if let Err(error) = write_message(&mut output, &notification, limits) {
                eprintln!("Transport write failure: {error}");
                return 1;
            }
        }
        if is_exit || router.is_exited() {
            return 0;
        }
    }
}

fn write_message<W: Write>(
    output: &mut W,
    message: &Message,
    limits: Limits,
) -> Result<(), FrameError> {
    let payload = serde_json::to_string(message)
        .map_err(|error| FrameError::Io(io::Error::new(io::ErrorKind::InvalidData, error)))?;
    write_frame(output, &payload, limits)
}

fn main() {
    if !std::env::args()
        .skip(1)
        .any(|argument| argument == "--stdio")
    {
        eprintln!("CWTools Rust language server requires --stdio");
        std::process::exit(2);
    }
    std::process::exit(run_stdio());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;

    #[test]
    fn writes_valid_json_rpc_frames_only() {
        let message = Message {
            jsonrpc: "2.0".to_owned(),
            id: None,
            method: Some("window/logMessage".to_owned()),
            params: Some(serde_json::json!({"type":3,"message":"test"})),
            result: None,
            error: None,
        };
        let mut bytes = Vec::new();
        write_message(&mut bytes, &message, Limits::default()).unwrap();
        let payload = read_frame(&mut BufReader::new(bytes.as_slice()), Limits::default()).unwrap();
        let parsed: Message = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed.method.as_deref(), Some("window/logMessage"));
    }
}
