import { createRequire } from "node:module";

const ts = createRequire(import.meta.url)("typescript");

const kindOf = (path) => (/\.tsx$/.test(path) ? ts.ScriptKind.TSX : /\.(?:js|mjs|cjs)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
export const parse = (path, text) => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kindOf(path));

function unwrap(node) {
  let e = node;
  while (e && (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression?.(e) || ts.isSatisfiesExpression?.(e))) e = e.expression;
  return e;
}

const literalText = (node) => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null);

function memberName(node) {
  const e = unwrap(node);
  if (!e) return null;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e)) return literalText(e.argumentExpression);
  return null;
}

function each(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => each(child, visit));
}

const propertyKey = (name) => (name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier?.(name)) ? name.text : null);

function sources(node, out = []) {
  const e = unwrap(node);
  if (!e) return out;
  if (ts.isBinaryExpression(e) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(e.operatorToken.kind)) {
    sources(e.left, out);
    sources(e.right, out);
  } else if (ts.isConditionalExpression(e)) {
    sources(e.whenTrue, out);
    sources(e.whenFalse, out);
  } else out.push(e);
  return out;
}

function aliasesOf(file, member, seedNames = []) {
  const aliases = new Set(seedNames);
  const keys = new Set([member]);
  const refersToMember = (node) => sources(node).some((e) => memberName(e) === member || (ts.isIdentifier(e) && aliases.has(e.text)) || (keys.has(memberName(e) ?? "") && memberName(e) !== null));
  for (let changed = true, rounds = 0; changed && rounds < 6; rounds++) {
    const before = aliases.size + keys.size;
    each(file, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && refersToMember(node.initializer)) aliases.add(node.name.text);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && refersToMember(node.right)) aliases.add(node.left.text);
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && ts.isObjectBindingPattern(node.parent)) {
        const key = propertyKey(node.propertyName) ?? node.name.text;
        if (keys.has(key)) aliases.add(node.name.text);
      }
      if (ts.isPropertyAssignment(node) && node.initializer && refersToMember(node.initializer)) {
        const key = propertyKey(node.name);
        if (key) keys.add(key);
      }
      if (ts.isShorthandPropertyAssignment(node) && aliases.has(node.name.text)) keys.add(node.name.text);
    });
    changed = aliases.size + keys.size !== before;
  }
  return aliases;
}

function calls(file, member, { seedNames = [], members = true } = {}) {
  const aliases = aliasesOf(file, member, seedNames);
  const applies = aliasesOf(file, "apply", ["apply"]);
  const isTarget = (node) => {
    const e = unwrap(node);
    return !!e && ((members && memberName(e) === member) || (ts.isIdentifier(e) && aliases.has(e.text)));
  };
  const found = [];
  each(file, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = unwrap(node.expression);
    const args = node.arguments;
    if (isTarget(callee)) return void found.push(args);
    const viaName = memberName(callee);
    if ((viaName === "call" || viaName === "apply") && isTarget(callee.expression)) {
      const rest = viaName === "call" ? args.slice(1) : args[1] && ts.isArrayLiteralExpression(unwrap(args[1])) ? unwrap(args[1]).elements : [];
      return void found.push(rest);
    }
    const isApply = (ts.isIdentifier(callee) && applies.has(callee.text)) || memberName(callee) === "apply";
    if (isApply && args.length >= 3 && isTarget(args[0])) {
      const list = unwrap(args[2]);
      return void found.push(ts.isArrayLiteralExpression(list) ? list.elements : []);
    }
  });
  return found.map((list) => ({ name: literalText(list[0] && unwrap(list[0])) }));
}

const remembered = new Map();
const memo = (kind, path, text, compute) => {
  const key = `${kind}\0${path}\0${text}`;
  if (!remembered.has(key)) remembered.set(key, compute());
  return remembered.get(key);
};

export const evaluateCalls = (path, text) => (text.includes("evaluate") ? memo("evaluate", path, text, () => calls(parse(path, text), "evaluate").length) : 0);

export const listenerCalls = (path, text) => memo("listener", path, text, () => calls(parse(path, text), "addEventListener"));

export const messageCalls = (path, text) =>
  memo("message", path, text, () => {
    const file = parse(path, text);
    return [...calls(file, "send", { seedNames: ["send"], members: false }), ...calls(file, "post", { seedNames: ["post"], members: false })];
  });
