; 来源：airbus-cert/tree-sitter-powershell 17f0c1a6514d3b46e64df7b88f464c0bd85078a6，MIT；按 Web 主题适配 capture 分类。
"param" @keyword
"dynamicparam" @keyword
"begin" @keyword
"process" @keyword
"end" @keyword
"if" @keyword
"elseif" @keyword
"else" @keyword
"switch" @keyword
"foreach" @keyword
"for" @keyword
"while" @keyword
"do" @keyword
"until" @keyword
"function" @keyword
"filter" @keyword
"workflow" @keyword
"break" @keyword
"continue" @keyword
"throw" @keyword
"return" @keyword
"exit" @keyword
"trap" @keyword
"try" @keyword
"catch" @keyword
"finally" @keyword
"data" @keyword
"inlinescript" @keyword
"parallel" @keyword
"sequence" @keyword

"-as" @operator
"-ccontains" @operator
"-ceq" @operator
"-cge" @operator
"-cgt" @operator
"-cle" @operator
"-clike" @operator
"-clt" @operator
"-cmatch" @operator
"-cne" @operator
"-cnotcontains" @operator
"-cnotlike" @operator
"-cnotmatch" @operator
"-contains" @operator
"-creplace" @operator
"-csplit" @operator
"-eq" @operator
"-ge" @operator
"-gt" @operator
"-icontains" @operator
"-ieq" @operator
"-ige" @operator
"-igt" @operator
"-ile" @operator
"-ilike" @operator
"-ilt" @operator
"-imatch" @operator
"-in" @operator
"-ine" @operator
"-inotcontains" @operator
"-inotlike" @operator
"-inotmatch" @operator
"-ireplace" @operator
"-is" @operator
"-isnot" @operator
"-isplit" @operator
"-join" @operator
"-le" @operator
"-like" @operator
"-lt" @operator
"-match" @operator
"-ne" @operator
"-notcontains" @operator
"-notin" @operator
"-notlike" @operator
"-notmatch" @operator
"-replace" @operator
"-shl" @operator
"-shr" @operator
"-split" @operator
"-and" @operator
"-or" @operator
"-xor" @operator
"-band" @operator
"-bor" @operator
"-bxor" @operator
"+" @operator
"-" @operator
"/" @operator
"\\" @operator
"%" @operator
"*" @operator
".." @operator
"-not" @operator


";" @delimiter

(string_literal) @string

(integer_literal) @number
(real_literal) @number

(command
  command_name: (command_name) @function.powershell.command)

(function_statement
  (function_name) @function)

(invokation_expression
  (member_name) @function)

(member_access
  (member_name) @property)

(command_invokation_operator) @operator

(type_spec) @keyword

(variable) @variable.powershell

(comment) @comment

(array_expression) @array

(assignment_expression
  value: (pipeline) @assignvalue)