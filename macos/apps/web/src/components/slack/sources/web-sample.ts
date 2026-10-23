export const WEB_SOURCE_SAMPLE = `{
  "name": "示例书源（改成你的站点）",
  "baseUrl": "https://example.com",
  "charset": "utf-8",
  "searchUrl": "/search?q={{key}}",
  "rules": {
    "search": {
      "list": ".book-item",
      "name": ".title@text",
      "author": ".author@text",
      "bookUrl": "a@href",
      "cover": "img@src",
      "intro": ".intro@text",
      "lastChapter": ".latest@text"
    },
    "book": {
      "name": "h1@text",
      "author": ".book-author@text",
      "intro": ".book-intro@text",
      "cover": ".book-cover img@src",
      "tocUrl": ""
    },
    "toc": {
      "list": ".chapter-list a",
      "name": "@text",
      "url": "@href"
    },
    "content": {
      "content": "#chapter-content",
      "remove": "script,style,.ads",
      "next": ""
    }
  }
}`;

export const WEB_SOURCE_HELP = `支持 Legado / 阅读书源 JSON：
- 书名、作者、地址、搜索地址、ruleSearch / ruleBookInfo / ruleToc / ruleContent
- 规则支持 @css:、@XPath:、@json: 和 ##正则##替换
- 搜索地址支持 {{key}}、{{page}}、{{baseUrl}}
- 章节目录里的相对链接会按当前页面地址补全
- 不支持 @js: 规则、POST 搜索配置、Cookie/登录、WebView 渲染
- 书源由你自己提供；请只抓取你有权访问的内容`;
