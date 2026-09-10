# 高亮语言覆盖核对

核对日期：2026-09-08。真相源是 `apps/web/src/components/workbench/diff-highlight.ts` 与 `apps/macos/Sources/NativeDiffHighlighter.swift` 的当前语言分派。

Web 的 61 种扩展名现在全部有原生解析入口。Dockerfile、Makefile 完整文件名识别也已接入。此结论只表示语言分派覆盖，不能代替全部语法、颜色、嵌入语言或视觉验收；JSONC 等复用相近语法的路径也不保证完整语法支持。

## 已接入但仍需验证的部分

- HTML：script/style 正文已接入原生 JS/CSS/JSON；事件属性、style 属性和其他模板类型仍有差距。
- Markdown：块/行内与已支持语言的围栏可高亮；嵌入 Markdown、更多方言仍未完整对齐。
- Dockerfile：shell_command 正文已接 Bash，覆盖 RUN/CMD/ENTRYPOINT/HEALTHCHECK CMD 和续行，排除 JSON exec 数组；heredoc 正文、自定义 SHELL 和 Windows escape 方言仍未完整对齐。
- 原生分词允许合理差异，但不能用这一点豁免缺失语言。
- 单个超长语法节点、查询谓词与排序仍有同步阶段；真实窗口帧率和多文件切换延迟未完整测量。

新增语言或修改 Web 映射后，应重新核对并更新本表；不能把这一日期的结果当作永久清单。

## XML 接入（2026-09-06）

- TreeSitterXML 锁定0.7.0（ABI14），使用原生C解析器与上游XML查询。支持大小写扩展名和Markdown xml围栏，未借用HTML解析器。
- 新增语义测试覆盖标签、属性名/值、实体引用、注释、中文/Emoji范围，CDATA内标签样式文本不能误着色为tag。
- 19项高亮测试全部通过（`/tmp/coflux-xml-highlight.log`）。这是语义范围测试，完整DTD声明、命名空间、错误恢复和同屏Web颜色对照仍待补充。
- 28项锁定依赖许可证同步校验通过；产物审计 `/tmp/coflux-xml-audit.json` 无脚本资源/直接Web运行时链接，签名完整。原生新增包的DTD产品随上游Swift Package编译，但尚未登记独立.dtd路径。

## PHP 接入（2026-09-06）

- TreeSitterPHP 锁定0.23.11（ABI14），采用上游C解析器与查询，登记.php（大小写不敏感）。带PHP起始标记的Markdown php围栏复用该管线。
- 新增关键词、函数名、数字、字符串、注释与Unicode范围测试；20项高亮回归通过（`/tmp/coflux-php-highlight.log`）。
- PHP/HTML混排的HTML着色、无起始标记的Markdown片段、插值/Herodoc/Nowdoc等专项与Web视觉对照仍待完成，不能据扩展名覆盖数视为全语法对齐。
- 29项锁定依赖许可证校验通过；`/tmp/coflux-php-audit.json`确认无脚本资源及直接Web运行时链接、签名完整。
- JSON5、SQL候选仓库master/Package.swift返回404，仅说明该路径不存在，尚不能据此判断原生语法库不可用；后续需核实分支或建立原生封装。

### PHP 模板与省略起始标记的围栏（2026-09-06）

- Markdown php围栏正文去掉首尾空白后未以<?开头时，使用同一依赖的 tree_sitter_php_only；带标记的围栏仍走完整PHP语法。
- PHP树的text节点交给现有原生HTML管线，映射UTF16范围回原文；不扫描echo等字符串里的标签。HTML内已有JS/CSS嵌入仍由HTML树决定。
- 新测试覆盖PHP前后HTML标签、属性/中文Emoji、PHP echo字符串内伪标签保持字符串色，以及无标记围栏的函数/return/数字/注释。21项高亮回归通过（`/tmp/coflux-php-embedded.log`）。
- 限制：每个模板text片段单独解析HTML，跨PHP边界的属性/脚本/注释上下文仍需完善；特殊围栏前缀、插值、Heredoc/Nowdoc及Web同屏颜色对照仍未完整验收。

### PHP 跨片段宿主上下文（2026-09-06）

- 替换逐text片段解析：用PHP树确定模板区域，其余UTF16码元等长留白并保留换行，整份送原生HTML及其JS/CSS嵌入管线。宿主capture通过范围交集仅写回模板文本，不覆盖PHP关键词/数字/字符串。
- 使用二分定位相交区域，避免所有capture与所有模板片段笛卡尔扫描；长准备/交集循环让出actor并检查取消。
- 新增属性、HTML注释、JS字符串被PHP打断后的语义验证，包括PHP数值仍保留自己的颜色及Emoji后的范围。22项高亮测试通过（`/tmp/coflux-php-contexts.log`）。
- 这解决了已覆盖的静态宿主前后文丢失；动态PHP输出改变HTML/JS语法的效果不能在不执行代码的情况下完整预知，仍按静态模板高亮。PHP特殊语法与同Web画面对照仍待验证。


### 2026-09-06：Kotlin 原生库接入前核查

- 已核实 tree-sitter-grammars/tree-sitter-kotlin 的默认分支master及v1.1.0（77dd60ea0a9003ce062c9728a513ffe1aaff8c82）均提供Package.swift；产品TreeSitterKotlin、C parser/scanner，v1.1.0解析器LANGUAGE_VERSION=14，与现有运行时一致。SwiftTreeSitter依赖from0.8.0可覆盖当前0.9.0锁定版本。
- 但GitHub递归tree证实v1.1.0与master都没有任何.scm文件，Package.swift却声明.copy("queries")。所以仅加SPM依赖并不能获得可用高亮，还需处理缺失资源路径并提供与该语法匹配的查询；尚未修改工程依赖或扩展名登记。
- INI/GraphQL候选tree-sitter-grammars仓库的Package.swift探测返回404，不据此断言没有原生库。覆盖仍为38/61。
- 下一步可按锁定语法节点定义编写独立原生查询，并验证包缺失queries目录是否导致构建失败；必要时采用固定源码的本地C target包装。不要把Kotlin假映射到Java解析器。


### 2026-09-06：Kotlin 接入验证完成

- TreeSitterKotlin 1.1.0固定版本已接入；实际Xcode构建成功，缺失的上游queries目录未阻止本次构建。运行时使用本仓库独立编写的kotlin-highlights.scm，不执行JS也不复用Java语法。
- 登记kt/kts（大小写不敏感）和Markdown kotlin围栏，扩展名分派覆盖更新为40/61。
- 24项高亮回归通过，日志 `/tmp/coflux-kotlin-highlight.log`；新增覆盖函数名、关键词、类型、数字、字符串、注释与Unicode范围。
- 30项锁定依赖许可检查通过；测试App产物审计 `/tmp/coflux-kotlin-audit.json`通过，无脚本资源或直接Web运行时链接，许可匹配且临时签名有效。
- Kotlin插值表达式、解构、DSL、注解、多行字符串细节及Web同状态颜色尚未完整验证；本次不代表完整语法覆盖或整体目标完成。


### 2026-09-06：Kotlin 字符串插值

- 当前Web高亮实测$name为蓝色，${count + 1}内count仍为字符串色、运算符为红色、数字蓝色、调用函数紫色。原生按此行为对齐。
- 上游1.1.0解析树把普通字符串$name拆为string_content，多行字符串则产生interpolation。查询处理真实插值节点；Swift在普通string_literal的相邻string_content范围内用原生NSRegularExpression补简单插值，转义与表达式节点隔断范围。未改用JS，已移除临时解析树输出。
- 25项高亮回归通过，日志 `/tmp/coflux-kotlin-escaped-interpolation.log`。验证普通/多行字符串、数字/函数/运算符、转义美元符不误染、中文变量和注释范围。
- 反引号标识符、复杂嵌套模板、DSL与完整Web视觉仍待验收；此项不扩大扩展名覆盖统计。


### 2026-09-06：Elixir 原生解析器接入

- TreeSitterElixir固定0.3.5（e2d9e6e0e76b0c436fa48a0b8c32a031d0cbdf49），ABI14；使用上游C parser/scanner及原始高亮查询，运行时不执行JS。
- 登记ex/exs（大小写不敏感）和Markdown elixir围栏，语言分派覆盖更新为42/61。
- 26项原生高亮测试全部通过，日志 `/tmp/coflux-elixir-highlight.log`；新增验证模块定义关键词、函数名、数字、中文/Emoji字符串与注释范围。
- 31项锁定依赖许可校验通过；产物审计 `/tmp/coflux-elixir-audit.json` 确认无脚本资源及直接Web运行时链接、许可匹配、临时签名有效。
- Elixir sigil、插值、管道、文档属性、复杂模式匹配及Web同状态视觉仍待验收；扩展名覆盖不代表完整语法或整体功能对齐。


### 2026-09-06：Erlang 与 Haskell 原生接入

- Haskell固定TreeSitterHaskell 0.23.1，Erlang固定上游0.20提交67e7f7f05baf492ca2a7c0d9538761b242d33d95，均为ABI14。登记erl/hrl/hs与对应Markdown围栏，当前实际分派核对45/61。
- Erlang上游manifest把tools-version放在第二行，SwiftPM拒绝；同时漏列parser实际引用的外部scanner。因此NativeGrammars本地Swift包原样保存固定提交C源码，显式编译parser/scanner；manifest记录来源与SHA-256，许可同步脚本检查哈希并嵌入Apache LICENSE。没有修改SPM下载缓存或引入JS运行时。
- 初次28项测试有6条函数颜色断言失败：Erlang的string.special.symbol优先级覆盖function，Haskell上游(variable) @type误染所有变量。现分别将atom改为constant、把type变量限定为(type/variable)，保留其余原生查询。临时capture日志已移除。
- Web当前实测Erlang函数紫色、atom蓝色，与修正后原生一致。Web对示例Haskell无签名函数名保持正文色，原生按语义显示紫色，属于已知局部分词颜色差异；没有为此增加Web运行层。
- 28项高亮回归通过，日志 `/tmp/coflux-erlang-haskell-fixed.log`；验证关键词、函数名、数字、字符串、注释、Unicode范围与围栏。32项远端锁定依赖及1项本地语法许可检查通过；`/tmp/coflux-erlang-haskell-audit.json`无脚本资源/直接Web运行时链接，许可与临时签名有效。
- Erlang宏/record/二进制匹配和Haskell复杂类型/布局规则/quasiquote及完整视觉仍待验收。这是新增语言定向回归，不替代最新改动后的全套或总体目标验收。


### 2026-09-06：SCSS 接入与 GraphQL 候选核查

- SCSS固定tree-sitter-grammars/tree-sitter-scss提交2ef6d42e3ad7a8208900f9346f4529806ae0f9f9，ABI14，使用上游Swift产品及C parser/scanner。旧v1.0.0缺LICENSE，选择包含完整MIT文件的固定提交。
- 登记.scss（大小写不敏感）及Markdown scss围栏；组合既有CSS基础查询与SCSS扩展查询，覆盖mixin、include、嵌套规则及字符串/注释。基础接入29项高亮回归通过 `/tmp/coflux-scss-highlight.log`。
- Web实测SCSS变量橙色、单位红色、mixin函数紫色。原生新增variable.scss和unit.scss捕获映射；声明左侧由property_name表示，另用仅匹配$前缀的规则着色，普通CSS属性不受影响。修正后29项高亮回归通过 `/tmp/coflux-scss-declarations.log`。
- GraphQL候选bkegley/tree-sitter-graphql提交5e66e961eee421786bdda8495ed1db045e06b5fe有ABI13 C解析器、queries/graphql/highlights.scm及MIT LICENSE，无Swift包；尚未接入，不计为覆盖。
- SCSS插值、模块调用、控制流和完整视觉仍待验证，登记覆盖46/61不等于完整语法验收。

- SCSS最终产物审计 `/tmp/coflux-scss-audit.json` 通过：无脚本资源和直接Web运行时链接，许可匹配、临时签名有效；33项远端锁定依赖及1项本地原生语法许可检查通过。


### 2026-09-06：GraphQL 原生接入完成

- 固定bkegley/tree-sitter-graphql提交5e66e961eee421786bdda8495ed1db045e06b5fe（ABI13），本地Swift C target封装parser及最小函数声明；原始源码哈希与MIT LICENSE纳入NativeGrammars清单和许可同步脚本。
- 登记graphql/gql（大小写不敏感）与Markdown graphql围栏，扩展名覆盖48/61。未引入JS运行层。
- 对照当前Web真实highlightLines输出，操作名紫色、变量/字段/参数橙色、类型/数字/布尔蓝色、非空标记红色。上游查询capture增加GraphQL限定分类，避免改变其他语言的类型/属性颜色；float改为number.float以参与现有数字着色。
- 30项高亮回归通过，日志 `/tmp/coflux-graphql-highlight.log`，包含查询/类型声明/变量/浮点数/Unicode注释和字符串/Markdown。产物 `/tmp/coflux-graphql-audit.json` 审计通过；33项远端锁定依赖及2项本地语法的源码/许可检查通过。
- fragment、directive、block string、schema扩展、错误恢复及完整视觉仍待专项验证；当前定向回归不代表整体功能、视觉或性能验收完成。


### 2026-09-06：JSON5 原生接入

- 固定Joakker/tree-sitter-json5提交966aaa2a6c27a206a5fa11ccbc44122d3daa9c5d，ABI14。本地Swift C target封装，原始源码/许可证纳入NativeGrammars清单及哈希验证。
- 上游较新v0.1.0及当前主分支生成ABI15，现有运行时仅接受13–14；没有修改ABI常量假冒兼容，也没有为单个语法升级全体运行时。
- 登记json5（大小写不敏感）与Markdown围栏，覆盖49/61。原生独立JSON5语法支持无引号键、单引号字符串、尾逗号、注释及特殊数字，未冒用普通JSON解析器。
- Web实测无引号键为字符串色，数字/Infinity/NaN为蓝色；本地查询将identifier归为string.special.key。31项高亮回归通过 `/tmp/coflux-json5-highlight.log`，新增样例含中英文/Emoji、行注释/块注释、0x2A、.5、Infinity、NaN和布尔值。
- 产物 `/tmp/coflux-json5-audit.json` 审计通过；33项远端锁定依赖及3项本地语法源码/许可检查通过。无脚本资源和直接Web运行时链接，临时签名有效。
- 转义标识符、字符串续行、全部数值边界、错误恢复及完整视觉仍待专项验收；当前结果不证明整体目标完成。


### 2026-09-06：Protobuf 原生高亮

- 固定treywood/tree-sitter-proto提交e9f6b43f6844bd2189b50a422d4e2094313f6aa3，ABI14；本地Swift C target封装，源码SHA-256与MIT许可纳入NativeGrammars清单。
- 登记proto（大小写不敏感）与Markdown围栏，覆盖50/61。对照Web，消息/枚举名用类型色、标量类型用关键词色、赋值符红色、字段编号蓝色。
- 首次回归发现syntax版本不是string节点，导致普通.proto文件的proto3无色；Markdown围栏背景色会掩盖这类遗漏。补充专用proto2/proto3字面量规则后，32项高亮回归通过 `/tmp/coflux-proto-fixed.log`。
- 产物 `/tmp/coflux-proto-audit.json` 审计通过；33项远端依赖与4项本地原生语法源码/许可检查通过，无脚本资源/直接Web运行时链接、临时签名有效。
- 服务/RPC、map/oneof、嵌套消息、proto2专属字段与editions方言仍待专项验收；扩展名登记不代表全方言或整体目标完成。


### 2026-09-06：SQL 原生高亮

- 固定DerekStride/tree-sitter-sql生成分支提交9853b887c5e4309de273922b681cc7bc09e30c78（来源8a4578bd200fd1ed73e8cbecbe3c5053a4bcf2f8），ABI14，使用上游Swift产品TreeSitterSql。main不保存生成parser，最新生成分支和v0.3.11产物为ABI15，未误接入不兼容产物。
- 登记sql（大小写不敏感）和Markdown围栏，覆盖51/61；不是复用其他语言语法。
- 上游数字查询使用Lua模式%d，当前Swift谓词引擎使用ICU正则；本地改为[0-9]，float归入number.float并增加指数形式。Web实测SELECT/字符串/整数同色，但小数点及2e3保持正文色；原生把整个有效数值着色，记录为合理语义差异。
- 33项高亮回归通过 `/tmp/coflux-sql-highlight.log`，新增覆盖CREATE TABLE、SELECT/FROM/WHERE、整数/小数/指数、Unicode注释和字符串及围栏。
- 产物 `/tmp/coflux-sql-audit.json` 审计通过；34项远端锁定依赖及4项本地原生语法许可检查通过，无脚本资源/直接Web运行时链接、临时签名有效。
- SQL方言（PostgreSQL/MySQL/SQLite等）专用语法、存储过程、美元字符串、参数和完整视觉仍待验证；不能从通用语法登记推断全部SQL支持或整体完成。


### 2026-09-07：R 与 INI 原生接入验收

- R与INI均锁定上游1.3.0，ABI14；R为MIT、INI为Apache许可。INI最新1.4.0为ABI15，未使用不兼容版本。登记r/ini（大小写不敏感）和围栏，当前源码核对53/61，尚缺dart/groovy/less/pl/ps1/svelte/vue/zsh。
- 对照Web真实输出，R变量橙色、调用紫色、关键字红色；INI键名红色、section名称橙色、引号值字符串色，裸文本/数字/布尔不做类型着色。
- 上轮35项测试成功日志已核实 `/tmp/coflux-r-ini-highlight.log`；本轮新增INI带空格等号边界，发现setting_value包含前导空白，修正谓词允许空格/制表符后36项高亮回归通过 `/tmp/coflux-ini-values-fixed.log`，含裸值无capture负向断言。
- 36项锁定远端依赖及4项本地原生语法许可/哈希检查通过，最终 `/tmp/coflux-r-ini-final-audit.json` 审计通过，无脚本资源/直接Web运行时链接、许可匹配、临时签名有效。
- R复杂管道/原始字符串/命名空间和INI多行/不同方言/完整视觉仍待验收。此为高亮定向回归，不是整体功能和性能完成证据。

### 2026-09-08：Dart 原生接入

- 固定 UserNobody14/tree-sitter-dart 的 ABI 14 提交 c8e7cbbd1589cc2ee1f9b5befa604dc7e953b0af，使用 C parser/scanner 和上游 Swift 公开头。本地 target 避开上游 SwiftPM 检出时不必要的 SSH 子模块，不引入 JS 运行时。MIT LICENSE 与源码哈希纳入 NativeGrammars 清单。
- 登记 dart、大小写扩展名与 Markdown dart 围栏，当前覆盖 54/61；尚缺 groovy/less/pl/ps1/svelte/vue/zsh。按当前 Web 实际 highlightLines 输出将 Dart 类型设为蓝色，补扩展类型的 type 关键词和简单插值着色；原始字符串保持字符串色。
- 38 项高亮回归通过，0 失败，日志 `/tmp/coflux-dart-interpolation.log`，包含中文/Emoji、类/函数调用、嵌套调用数字、原始字符串、简单插值、扩展类型与范围边界。最初基础 37 项也通过 `/tmp/coflux-dart-native-highlight.log`。
- 36 项远端依赖 + 5 项本地语法的许可证和源码哈希检查通过。`/tmp/coflux-dart-final-audit.json` 通过，无脚本资源/直接 Web 运行时链接，许可一致、临时签名完整；仍是 Performance 测试产物。
- 当前版本不含后续 Dart 3.10 dot shorthand、部分运算优先级和泛型方法修复；复杂嵌套插值、完整错误恢复及逐屏视觉仍待验收。扩展名覆盖不代表所有 Dart 版本语法或整体目标完成。


## Less 原生语法接入（2026-09-08）

- 固定 mdovale/tree-sitter-less 提交 02988c765d30adb0476657b5d220e8dfde1c07d3，ABI 14，原样编译 C parser/scanner，MIT 原文及源码哈希纳入 NativeGrammars/manifest.json。无 JS 运行时。
- Less 文件、大小写扩展名与 Markdown less 围栏已接入；当前源码核对为 55/61，剩 groovy/pl/ps1/svelte/vue/zsh。
- 对当前 Web 的 Shiki github-dark-default 实测变量、混入、属性、单位与嵌套选择器颜色，再映射原生查询。39 项高亮回归全通过，0 失败，日志 `/tmp/coflux-less-highlight.log`；包括中文/Emoji 范围、变量声明/引用、混入定义/调用、嵌套伪类与 Markdown。
- 许可证与全部本地语法源码哈希检查通过；最新测试产物审计 `/tmp/coflux-less-final-audit.json` 通过，无脚本资源或直接 Web 运行时链接，许可一致、临时签名有效。
- 本轮覆盖上述语义样本；复杂守卫、变量插值、导入选项与完整视觉仍需验收。扩展名登记不代表全部 Less 语法和整体目标已完成。


## Vue/Svelte 原生模板接入（2026-09-08）

- Vue 固定 tree-sitter-grammars/tree-sitter-vue 提交 22bdfa6c9fc0f5ffa44c6e938ec46869ac8a99ff，Svelte 固定 ae5199db47757f785e43a14b332118a5474de1a2；两者均 ABI 14，原样编译 C parser/scanner。MIT 原文与源码哈希纳入 NativeGrammars/manifest.json。
- 扩展名与 Markdown 围栏接入两种独立模板语法；script/style 根据 lang 分派到 JS/TS/JSX/TSX/CSS/SCSS/Less 原生解析器，未支持的 lang 保持纯文本。HTML 原来的 type 分派继续保留，普通 HTML 不按组件 lang 扩展解释。
- Vue 插值、指令属性与动态参数，Svelte 表达式、条件块和事件属性均通过宿主节点定位正文再解析。表达式区域先清除 HTML 属性字符串底色，避免普通变量错误继承整段字符串色。注释和普通文字属性不进入脚本解析。
- 直接运行当前 Web Shiki/github-dark-default 得到对照：标签绿、属性蓝、关键字红、数字蓝、字符串浅蓝。Vue 指令名/参数/修饰符已改为属性蓝。该 Web 样本的 Vue 指令值仍为整段字符串色、插值和 Less/SCSS 样式正文为默认色；原生保留更细的表达式/样式语义，属于已知着色差异，不宣称逐像素一致。
- 首轮 42 项高亮回归全部通过，日志 `/tmp/coflux-components-highlight.log`，包含两种文件/大小写/围栏、TS 脚本、模板事件/数字、嵌套样式和注释/普通属性/未知 lang 边界。语言扩展名覆盖现为 57/61，剩 groovy/pl/ps1/zsh。
- 完整 Svelte each/await/snippet、复杂 Vue 指令语义、Pug 等其他预处理语言及逐屏视觉仍需验收；本轮扩展名登记不能替代完整组件方言验收。

- 指令颜色新增断言曾发现上游 `function.method` 查询优先级覆盖本地属性色；已直接修正对应 capture 分类。最终 `/tmp/coflux-components-verified-highlight.log`：42 项全部通过、0 失败，1.157 秒。
- 最终 `/tmp/coflux-components-final-audit.json` 通过：无脚本资源/直接 Web 运行时链接，许可一致、临时签名有效。34 项远端依赖及 8 项本地语法的许可/源码哈希检查通过，490772 字节。本轮没有访问钥匙串，也未重复网络/终端全套或正式分发验收。


## PowerShell/Perl 原生高亮（2026-09-08）

- PowerShell 使用固定 ABI 14 提交 17f0c1a6514d3b46e64df7b88f464c0bd85078a6 的原始 parser/scanner。Perl 固定 2.0.0 提交 50904961d6a87c5191e611276aa2ecb9d66ca4ff，由官方 tree-sitter-cli 0.26.6 以 --abi 14 生成 C parser；输入与固定提交相同，独立重生成产物哈希一致。命令、工具/输入哈希及来源均在 NativeGrammars/manifest.json，非修改 ABI 常量。
- .ps1/.pl、大小写扩展名、Markdown powershell/perl/pwsh 围栏已接入，当前覆盖 59/61，剩 groovy/zsh。PowerShell 函数定义、命令调用、类型、运算符和字符串插值，以及 Perl 子程序、内置函数、变量插值、正则与修饰符有定向验收。
- 44 项高亮回归全部通过，0 失败，日志 `/tmp/coflux-perl-powershell-highlight.log`，1.393 秒。Web 实测支持命令/内置函数蓝色、普通插值变量默认色、关键字红色；Perl 普通数字的 Web 样本未着色，原生保留数字蓝色，属于已知分词差异。
- 除根 MIT 外，Perl 内部 bsearch 的 BSD 许可单独提取并纳入随 App 分发的 notices；生成器/原始源码文件均有 SHA-256。原始 Perl C scanner 的四处整数窄化编译警告仍存在，本轮没有改第三方源码，也不宣称零警告构建。
- 完整 PowerShell here-string/类/管道复杂表达式、Perl 多 heredoc/嵌套正则/POD/错误恢复与逐屏视觉仍需验收。本轮不是整体 UI/功能/性能或正式分发完成证据。

- 补齐 BSD notices 后最终构建成功，日志 `/tmp/coflux-perl-powershell-final-build.log`。`/tmp/coflux-perl-powershell-final-audit.json` 通过：当前 Performance App 仅主程序与 WebRTC 两个 Mach-O，无测试框架、脚本资源或直接 Web 运行时链接；许可一致、临时签名有效。许可/源码哈希检查通过，共 495008 字节，仍非正式签名、公证或发布验收。


## Groovy/Zsh 接入与语言入口覆盖闭环（2026-09-08）

- Groovy 固定 deb0dcf8c4544f07564060f6e9b9f6e4b0bfc27d，Zsh 固定 7a593401efb5418ffdedbe3c0e4c61c6d240166d，来源见 NativeGrammars/manifest.json。官方生成器从各自固定 grammar.json 生成 ABI 14，独立重生成的全部 C/header 哈希一致；Groovy 只编译 parser，Zsh 同时编译原始 scanner，MIT 原文随包分发。
- 两种扩展名、大小写和 Markdown 围栏均接入。Groovy 类/函数/闭包调用/字符串及数字，Zsh 函数、局部声明、数组、`**/*.swift(N.)` glob 限定符、`${(u)files}` 参数展开和字符串变量有定向语义验收。
- 首轮发现 Groovy 上游语法将尾随闭包拆成相邻节点、Zsh 引号变量为 variable_ref，已据真实树修正查询。另修复 Markdown 代码正文未单独着色的标识符继承围栏字符串色；现在先应用默认代码前景再覆盖语言语义。
- 最终 `/tmp/coflux-groovy-zsh-fixed-highlight.log`：47 项高亮回归全部通过、0 失败，1.314 秒。当前源码核对 Web 61 种扩展名全部可分派，不再有缺失语言入口。
- `/tmp/coflux-groovy-zsh-final-audit.json` 通过：无脚本资源/直接 Web 运行时链接，许可一致、临时签名有效。34 远端依赖、12 本地语法的源码/许可检查通过，共 497580 字节；这是包含 XCTest 的 Performance 测试产物。
- 仍有合理分词差异：Web Groovy 样本对尾随闭包上下文部分文本整体着色，原生按实际节点区分；不宣称逐像素完全相同。复杂 Groovy DSL、Zsh glob 修饰符自定义分隔符（上游已注明限制）、错误恢复及完整逐屏视觉仍需验收。覆盖全部扩展名不代表整体目标完成。
