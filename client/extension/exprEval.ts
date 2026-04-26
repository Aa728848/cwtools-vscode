export function safeEval(expr: string): number {
    let i = 0;
    function skipWs() { while (i < expr.length && expr[i] === ' ') i++; }
    function factor(): number {
        skipWs();
        if (expr[i] === '(') { i++; const v = exprLoop(); skipWs(); i++; return v; }
        let start = i;
        if (expr[i] === '-') i++;
        while (i < expr.length && /[0-9.]/.test(expr[i]!)) i++;
        return parseFloat(expr.slice(start, i));
    }
    function term(): number {
        let v = factor(); skipWs();
        while (i < expr.length && (expr[i] === '*' || expr[i] === '/')) {
            const op = expr[i++]!; const r = factor();
            v = op === '*' ? v * r : v / r; skipWs();
        }
        return v;
    }
    function exprLoop(): number {
        let v = term(); skipWs();
        while (i < expr.length && (expr[i] === '+' || expr[i] === '-')) {
            const op = expr[i++]!; const r = term();
            v = op === '+' ? v + r : v - r; skipWs();
        }
        return v;
    }
    return exprLoop();
}