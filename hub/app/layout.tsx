import type { ReactNode } from 'react';
import { hubLang, hubName } from '@/lib/config';
import { t } from '@/lib/i18n';

export function generateMetadata() {
  return { title: hubName(), description: t().metaDescription };
}

const css = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--muted:#5d6470;--line:#e2e5ea;--accent:#c2410c;--ok:#15803d;--warn:#b45309;--bad:#b91c1c;--bar:#e9ecf0}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#111317;--card:#1a1d23;--ink:#eceef2;--muted:#9aa1ad;--line:#2b2f37;--accent:#fb923c;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--bar:#2b2f37}}
:root[data-theme="dark"]{--bg:#111317;--card:#1a1d23;--ink:#eceef2;--muted:#9aa1ad;--line:#2b2f37;--accent:#fb923c;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--bar:#2b2f37}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}
main{max-width:860px;margin:0 auto;padding:20px 16px 60px}h1{font-size:22px;margin:4px 0 4px}h2{font-size:17px;margin:28px 0 10px}
.sub{color:var(--muted);margin:0 0 8px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
.row{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline}.muted{color:var(--muted);font-size:13px}
.bar{height:8px;background:var(--bar);border-radius:4px;overflow:hidden;margin:8px 0 4px}.bar>i{display:block;height:100%;background:var(--accent)}
.tag{font-size:12px;padding:1px 8px;border-radius:9px;border:1px solid var(--line)}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{border-bottom:1px solid var(--line);padding:6px 4px;text-align:left;vertical-align:top}
.scroll{overflow-x:auto}input,select{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);width:100%}
label{display:block;font-size:13px;color:var(--muted);margin:8px 0 2px}button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:0 12px}
.actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}code{word-break:break-all;background:var(--bar);padding:2px 5px;border-radius:5px}
ol{padding-left:20px}li{margin:4px 0}
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={hubLang()}>
      <body>
        <style dangerouslySetInnerHTML={{ __html: css }} />
        {children}
      </body>
    </html>
  );
}
