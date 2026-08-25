use cwtools_lsp::Router;
use cwtools_protocol::{Message, RequestId};
use serde_json::{Value, json};

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
#[allow(clippy::needless_pass_by_value)]
fn command(router: &mut Router, id: i64, name: &str, args: Value) -> Value {
    router
        .route(&request(
            id,
            "workspace/executeCommand",
            json!({"command":name,"arguments":[args]}),
        ))
        .unwrap()
        .result
        .unwrap()
}
fn initialized() -> Router {
    let mut router = Router::default();
    assert!(router.route(&request(1, "initialize", json!({}))).is_some());
    assert!(
        router
            .route(&notification("initialized", json!({})))
            .is_none()
    );
    router.drain_notifications();
    router
}

#[test]
fn real_game_workspace_cache_and_localisation_commands_are_bounded() {
    let mut router = initialized();
    assert!(router.route(&notification("textDocument/didOpen",json!({"textDocument":{"uri":"file:///events/a.txt","languageId":"stellaris","version":1,"text":"foo = { bar = baz }"}}))).is_none());
    router.drain_notifications();
    let status = command(&mut router, 2, "cwtools.ai.getValidationStatus", json!({}));
    assert_eq!(status["sourceCount"], 1);
    assert!(
        status["cacheFingerprint"]
            .as_str()
            .is_some_and(|value| value.len() == 16)
    );
    let profile = command(
        &mut router,
        3,
        "cwtools.ai.getEntityInfo",
        json!({"gameId":"stellaris"}),
    );
    assert_eq!(profile["localisation"]["defaultLanguage"], "l_english");
    let audit = command(
        &mut router,
        4,
        "cwtools.ai.queryLocalisationAudit",
        json!({"gameId":"stellaris","path":"test_l_english.yml","text":"l_english:\n good:0 \"Hello\"\n broken"}),
    );
    assert!(
        audit["entries"]
            .as_array()
            .is_some_and(|items| items.len() <= 512)
    );
    assert!(
        audit["diagnostics"]
            .as_array()
            .is_some_and(|items| !items.is_empty() && items.len() <= 512)
    );
}

#[test]
fn real_shader_project_and_runtime_commands_are_bounded() {
    let mut router = initialized();
    let shader =
        "Includes = { \"common.fxh\" }\nEffect Test { VertexShader = VSMain PixelShader = PSMain }";
    let validate = command(
        &mut router,
        10,
        "cwtools.ai.shader.validate",
        json!({"file":"main.shader","text":shader}),
    );
    assert!(
        validate["diagnostics"]
            .as_array()
            .is_some_and(|items| items.len() <= 512)
    );
    let symbols = command(
        &mut router,
        11,
        "cwtools.ai.shader.symbols",
        json!({"file":"main.shader","text":shader}),
    );
    assert!(
        symbols["symbols"]
            .as_array()
            .is_some_and(|items| items.len() <= 512)
    );
    let unit = command(
        &mut router,
        12,
        "cwtools.ai.shader.compileUnit",
        json!({"file":"main.shader","text":shader,"sources":[{"file":"main.shader","logicalPath":"main.shader","text":shader},{"file":"common.fxh","logicalPath":"common.fxh","text":"float4 Helper;"}]}),
    );
    assert_eq!(unit["root"], "main.shader");
    assert!(
        unit["members"]
            .as_array()
            .is_some_and(|items| items.len() <= 512)
    );
    let callers = command(
        &mut router,
        13,
        "cwtools.ai.shader.callers",
        json!({"file":"main.shader","text":shader,"name":"Test","resources":[{"file":"interface/a.gui","text":"shader = Test"}]}),
    );
    assert!(
        callers["callers"]
            .as_array()
            .is_some_and(|items| items.len() <= 512)
    );
    let reachability = command(
        &mut router,
        14,
        "cwtools.ai.shader.reachability",
        json!({"file":"main.shader","text":shader,"effectName":"Test","resources":[{"file":"interface/a.gui","text":"shader = Test"}]}),
    );
    assert_eq!(reachability["status"], "ok");
    assert!(reachability["effect"].is_object());
    let comparison = command(
        &mut router,
        15,
        "cwtools.ai.shader.compareVanilla",
        json!({"file":"main.shader","text":shader,"effectName":"Test"}),
    );
    assert_eq!(comparison["status"], "ok");
    assert!(comparison["comparison"].is_object());
    let variants = command(
        &mut router,
        16,
        "cwtools.ai.shader.variants",
        json!({"file":"main.shader","text":"#if defined(PDX_OPENGL)\nEffect Test {}\n#endif"}),
    );
    assert!(variants["platforms"].is_array());
    assert!(variants["variants"].is_array());
    let preflight = command(
        &mut router,
        17,
        "cwtools.ai.shader.preflightEdit",
        json!({"file":"main.shader","text":shader,"proposedText":shader}),
    );
    assert_eq!(preflight["status"], "ok");
    assert_eq!(preflight["allowed"], true);
    let flow = command(
        &mut router,
        18,
        "cwtools.ai.analyzePdxFlow",
        json!({"file":"main.shader","text":shader,"limit":32}),
    );
    assert_eq!(flow["status"], "fresh");
    assert!(flow["analysis"]["definitions"].is_array());
    assert!(flow["analysis"]["calls"].is_array());
}
