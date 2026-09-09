// 静态引用检查：抓「使用但从未声明」的标识符（如漏写 const 的引用）。
// 这类错误语法合法、构建器不报错，只在运行时抛 ReferenceError。
// 用法：node scripts/check_refs.mjs [文件...]

import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import * as acorn from 'acorn'

const KNOWN_GLOBALS = new Set(
  [
    // JS / 标准
    'undefined', 'null', 'true', 'false', 'this', 'arguments',
    'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date', 'Error', 'TypeError', 'RangeError',
    'Infinity', 'NaN', 'isFinite', 'isNaN', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent',
    'Promise', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect',
    'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
    'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'ArrayBuffer', 'SharedArrayBuffer',
    'DataView', 'TextDecoder', 'TextEncoder', 'BigInt', 'RegExp', 'Function',
    // 宿主（浏览器）
    'window', 'document', 'console', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame',
    'ResizeObserver', 'WebSocket', 'Blob', 'URL', 'File', 'FileReader', 'Image', 'CustomEvent', 'Event',
    'AudioContext', 'webkitAudioContext', 'navigator', 'location', 'history', 'localStorage',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'structuredClone',
    'alert', 'confirm', 'getComputedStyle', 'matchMedia', 'DOMParser', 'XMLHttpRequest', 'fetch', 'AbortController',
    // Node（脚本用）
    'process', 'Buffer', 'globalThis', 'require', 'module', 'exports', '__dirname', '__filename', 'URL',
  ],
)

const files = process.argv.length > 2 ? process.argv.slice(2) : globSync('src/**/*.js')

let bad = 0
for (const file of files) {
  const code = readFileSync(file, 'utf8')
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
  const declared = new Set()
  const used = [] // {name, node}

  // 声明收集 + 引用收集（简化作用域：模块级 + 函数参数/局部声明就近可用）
  function collectDeclarations(node, scope) {
    if (!node || typeof node.type !== 'string') return
    switch (node.type) {
      case 'VariableDeclaration':
        for (const d of node.declarations) collectDeclarations(d, scope)
        break
      case 'VariableDeclarator':
        collectPattern(node.id, scope)
        break
      case 'FunctionDeclaration':
        if (node.id) scope.add(node.id.name)
        break
      case 'ClassDeclaration':
        if (node.id) scope.add(node.id.name)
        break
      case 'ImportDeclaration':
        for (const s of node.specifiers) scope.add(s.local.name)
        break
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
        collectDeclarations(node.declaration, scope)
        break
    }
    for (const key of Object.keys(node)) {
      const child = node[key]
      if (Array.isArray(child)) for (const c of child) collectDeclarations(c, scope)
      else if (child && typeof child.type === 'string') collectDeclarations(child, scope)
    }
  }

  function collectPattern(pat, scope) {
    if (!pat) return
    if (pat.type === 'Identifier') scope.add(pat.name)
    else if (pat.type === 'ObjectPattern') for (const p of pat.properties) collectPattern(p.value ?? p.argument, scope)
    else if (pat.type === 'ArrayPattern') for (const p of pat.elements) collectPattern(p, scope)
    else if (pat.type === 'AssignmentPattern') collectPattern(pat.left, scope)
    else if (pat.type === 'RestElement') collectPattern(pat.argument, scope)
  }

  // 两遍：先收集全部声明（宽松），再收集全部标识符引用
  const moduleScope = new Set()
  collectDeclarations(ast, moduleScope)
  // 函数参数与局部声明也计入（宽松策略：宁可漏报不误报）
  ;(function walkParams(node) {
    if (!node || typeof node.type !== 'string') return
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      for (const p of node.params) collectPattern(p, moduleScope)
    }
    if (node.type === 'CatchClause' && node.param) collectPattern(node.param, moduleScope)
    for (const key of Object.keys(node)) {
      const child = node[key]
      if (Array.isArray(child)) for (const c of child) walkParams(c)
      else if (child && typeof child.type === 'string') walkParams(child)
    }
  })(ast)

  ;(function walkRefs(node, parent, key) {
    if (!node || typeof node.type !== 'string') return
    if (node.type === 'Identifier') {
      const isProp = key === 'property' && parent?.type === 'MemberExpression' && !parent.computed
      const isKeyOfObj = parent?.type === 'Property' && parent.key === node && !parent.computed
      const isLabel = parent?.type === 'LabeledStatement' || parent?.type === 'BreakStatement' || parent?.type === 'ContinueStatement'
      const isMethodShorthand = parent?.type === 'MethodDefinition' || parent?.type === 'PropertyDefinition'
      if (!isProp && !isKeyOfObj && !isLabel && !isMethodShorthand) used.push(node)
    }
    for (const k of Object.keys(node)) {
      const child = node[k]
      if (Array.isArray(child)) {
        child.forEach((c) => walkRefs(c, node, k))
      } else if (child && typeof child.type === 'string') {
        walkRefs(child, node, k)
      }
    }
  })(ast, null, null)

  const undeclared = new Map()
  for (const id of used) {
    if (!moduleScope.has(id.name) && !KNOWN_GLOBALS.has(id.name)) {
      if (!undeclared.has(id.name)) undeclared.set(id.name, id.loc.start.line)
    }
  }
  if (undeclared.size) {
    bad += undeclared.size
    console.log(`✗ ${file}`)
    for (const [name, line] of undeclared) console.log(`    ${name}  (line ${line})`)
  } else {
    console.log(`✓ ${file}`)
  }
}

console.log(bad ? `\n✗ 发现 ${bad} 个未声明引用` : '\n✓ 引用检查全部通过')
process.exit(bad ? 1 : 0)
