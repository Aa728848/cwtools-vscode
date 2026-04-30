import { expect } from 'chai';
import { parseDsmlToolCalls, stripDsmlMarkup, stripThinkBlocks, cleanFinalContent } from '../../extension/ai/toolCallParser';

describe('parseDsmlToolCalls', () => {
    it('parses DeepSeek DSML invoke format', () => {
        const content = `<|DSML|invoke name="read_file">
<|DSML|parameter name="path">/test/file.txt</|DSML|parameter>
<|DSML|parameter name="offset">10</|DSML|parameter>
</|DSML|invoke>`;
        const calls = parseDsmlToolCalls(content);
        expect(calls).to.have.lengthOf(1);
        expect(calls[0]!.function.name).to.equal('read_file');
        const args = JSON.parse(calls[0]!.function.arguments);
        expect(args.path).to.equal('/test/file.txt');
        expect(args.offset).to.equal('10');
    });

    it('parses generic antml/invoke format', () => {
        const content = `<invoke name="search">
<parameter name="query">test query</parameter>
</invoke>`;
        const calls = parseDsmlToolCalls(content);
        expect(calls).to.have.lengthOf(1);
        expect(calls[0]!.function.name).to.equal('search');
        const args = JSON.parse(calls[0]!.function.arguments);
        expect(args.query).to.equal('test query');
    });

    it('parses Qwen function= format', () => {
        const content = `<function=search>
<parameter=query>find me</parameter=query>
</function>`;
        const calls = parseDsmlToolCalls(content);
        expect(calls).to.have.lengthOf(1);
        expect(calls[0]!.function.name).to.equal('search');
    });

    it('parses Qwen <tool_call> JSON format', () => {
        const content = `<tool_call>
{"name": "list_files", "arguments": {"path": "/src"}}
</tool_call>`;
        const calls = parseDsmlToolCalls(content);
        expect(calls).to.have.lengthOf(1);
        expect(calls[0]!.function.name).to.equal('list_files');
    });

    it('parses multiple tool calls in one response', () => {
        const content = `<invoke name="first">
<parameter name="a">1</parameter>
</invoke>
<invoke name="second">
<parameter name="b">2</parameter>
</invoke>`;
        const calls = parseDsmlToolCalls(content);
        expect(calls).to.have.lengthOf(2);
    });

    it('normalizes full-width pipes in DSML and still parses', () => {
        // U+FF5C (｜) is normalized to ASCII | by the parser
        const content = `<｜DSML｜invoke name="test">
<｜DSML｜parameter name="key">value</｜DSML｜parameter>
</｜DSML｜invoke>`;
        const calls = parseDsmlToolCalls(content);
        expect(calls).to.have.lengthOf(1);
        expect(calls[0]!.function.name).to.equal('test');
    });

    it('returns empty array for content with no tool calls', () => {
        const calls = parseDsmlToolCalls('just some regular text');
        expect(calls).to.be.empty;
    });

    it('returns empty array for empty string', () => {
        expect(parseDsmlToolCalls('')).to.be.empty;
    });

    it('handles nested tool_call/function tags safely (depth limit)', () => {
        const content = `<tool_call>
<function=inner>
<parameter=key>val</parameter=key>
</function>
</tool_call>`;
        const calls = parseDsmlToolCalls(content);
        expect(calls).to.have.lengthOf.at.least(1);
    });
});

describe('stripDsmlMarkup', () => {
    it('removes DSML function_calls blocks', () => {
        const content = `Hello<|DSML|function_calls>
<|DSML|invoke name="test"><|DSML|parameter name="x">y</|DSML|parameter></|DSML|invoke>
</|DSML|function_calls> world`;
        const cleaned = stripDsmlMarkup(content);
        expect(cleaned).to.equal('Hello world');
    });

    it('removes tool_call JSON blocks', () => {
        const content = 'text <tool_call>{"name":"f"}</tool_call> more';
        const cleaned = stripDsmlMarkup(content);
        expect(cleaned).to.include('text');
        expect(cleaned).to.include('more');
        expect(cleaned).to.not.include('tool_call');
    });

    it('removes antml function_calls blocks (may leave spacing)', () => {
        const content = 'before <antml_function_calls><antml_invoke name="x"></antml_invoke></antml_function_calls> after';
        const cleaned = stripDsmlMarkup(content);
        expect(cleaned).to.include('before');
        expect(cleaned).to.include('after');
        expect(cleaned).to.not.include('antml');
    });

    it('normalizes full-width pipes in markup', () => {
        const content = `text <｜DSML｜function_calls>
<｜DSML｜invoke name="x">stuff</｜DSML｜invoke>
</｜DSML｜function_calls> end`;
        const cleaned = stripDsmlMarkup(content);
        expect(cleaned).to.not.include('DSML');
        expect(cleaned).to.not.include('｜');
    });

    it('collapses multiple newlines', () => {
        const content = 'line1\n\n\n\n\nline2';
        const cleaned = stripDsmlMarkup(content);
        expect(cleaned).to.equal('line1\n\nline2');
    });

    it('handles empty string', () => {
        expect(stripDsmlMarkup('')).to.equal('');
    });
});

describe('stripThinkBlocks', () => {
    it('removes think blocks', () => {
        const content = 'answer <think>hmm let me think about this</think> result';
        const cleaned = stripThinkBlocks(content);
        expect(cleaned).to.not.include('think');
        expect(cleaned).to.include('answer');
        expect(cleaned).to.include('result');
    });

    it('removes multiline think blocks', () => {
        const content = 'start\n<think>\nline1\nline2\n</think>\nend';
        const cleaned = stripThinkBlocks(content);
        expect(cleaned).to.not.include('think');
        expect(cleaned.trim()).to.equal('start\n\nend');
    });

    it('handles no think block', () => {
        const content = 'plain text\nno tags here';
        expect(stripThinkBlocks(content)).to.equal('plain text\nno tags here');
    });
});

describe('cleanFinalContent', () => {
    it('removes both think and DSML blocks', () => {
        const content = 'text <think>reasoning</think> <tool_call>{"name":"f"}</tool_call> result';
        const cleaned = cleanFinalContent(content);
        expect(cleaned).to.not.include('think');
        expect(cleaned).to.not.include('tool_call');
        expect(cleaned).to.include('text');
        expect(cleaned).to.include('result');
    });

    it('handles undefined/empty', () => {
        expect(cleanFinalContent('')).to.equal('');
        expect(cleanFinalContent(undefined as unknown as string)).to.be.undefined;
    });
});
