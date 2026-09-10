; 来源：tree-sitter-grammars/tree-sitter-scss 2ef6d42e3ad7a8208900f9346f4529806ae0f9f9，MIT许可随App分发。
[
  "@at-root"
  "@debug"
  "@error"
  "@extend"
  "@forward"
  "@mixin"
  "@use"
  "@warn"
] @keyword

"@function" @keyword.function

"@return" @keyword.return

"@include" @keyword.import

[
  "@while"
  "@each"
  "@for"
  "from"
  "through"
  "in"
] @keyword.repeat

(js_comment) @comment @spell

(function_name) @function

[
  ">="
  "<="
] @operator

(mixin_statement
  name: (identifier) @function)

(mixin_statement
  (parameters
    (parameter) @variable.parameter))

(function_statement
  name: (identifier) @function)

(function_statement
  (parameters
    (parameter) @variable.parameter))

(plain_value) @string

(keyword_query) @function

(identifier) @variable

(variable) @variable

(argument) @variable.parameter

(arguments
  (variable) @variable.parameter)

[
  "["
  "]"
] @punctuation.bracket

(include_statement
  (identifier) @function)

; 本地适配：按当前 Web 暗色主题突出 SCSS 变量与单位。
(variable) @variable.scss
(unit) @unit.scss
; 声明左侧由 SCSS 语法表示为 property_name，普通 CSS 属性仍保持属性色。
((property_name) @variable.scss
 (#match? @variable.scss "^\\$"))
