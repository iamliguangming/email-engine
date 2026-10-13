# 代码规模复算

统计日期：2026-10-12。仅对 Git 跟踪文件做机械统计；这些文件不包含商业版源码。

| 仓库 | 固定提交 | 版本/说明 |
| --- | --- | --- |
| https://github.com/postalsys/emailengine | 5acd8dcfcd7ed6cd4c9b11dc88e568e84751f641 | package.json 2.83.2 |
| https://github.com/iamliguangming/email-engine | 197ca43f4fd979e3fb9a22505cecb694b57b30a8 | Kadri fork；上游基线 f2f4bac6e86d39aed105f21486da37e589537d12 |

工具：[cloc 2.06](https://github.com/AlDanial/cloc/releases/tag/v2.06)。不安装被统计仓库的依赖，不运行其脚本。在各仓库检出上面的提交，分别运行：

```sh
# 在商业版仓库中
perl /path/to/cloc-2.06.pl --git --by-file --json --out=/path/to/metrics/commercial-cloc.json .
# 在 Kadri fork 中
perl /path/to/cloc-2.06.pl --git --by-file --json --out=/path/to/metrics/kadri-cloc.json .
# 回到此目录
python3 summarize_code_size.py commercial commercial-cloc.json > commercial-size-summary.json
python3 summarize_code_size.py kadri kadri-cloc.json > kadri-size-summary.json
```

`*-cloc.json` 是原始按文件统计；`*-size-summary.json` 是分组汇总。分组脚本会核对 code/comment/blank 和文件数总和。cloc 原始报告的耗时和吞吐量字段每次运行不同，不影响行数。

`code` 排除空行和注释，但 JSON、模板和文档也有 code 行，不能将全仓总数视作程序代码。采用 cloc 默认识别与排除规则；不把 Git 文件数和 cloc 识别文件数混用。商业版 imap-core 子树、静态资源单列，不推断其全部为自研。主服务类别包含管理、配置等职责，不仅是同步算法。详细口径见上一级报告和分组脚本。
