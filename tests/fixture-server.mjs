import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testsRoot = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(testsRoot, "..");
const fixtureRoot = resolve(testsRoot, "fixtures");
const designRoot = resolve(projectRoot, "design-explorations");

createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname === "/lazy-image.svg") {
    setTimeout(() => {
      response.writeHead(200, {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "no-store"
      });
      response.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#16a34a"/></svg>'
      );
    }, 650);
    return;
  }

  const routeMap = {
    "/": resolve(fixtureRoot, "capture-page.html"),
    "/selector": resolve(fixtureRoot, "selector-harness.html"),
    "/pipeline": resolve(fixtureRoot, "pipeline-harness.html"),
    "/full": resolve(fixtureRoot, "full-harness.html")
  };
  const designPath = pathname.startsWith("/design/")
    ? resolve(designRoot, pathname.slice("/design/".length))
    : undefined;
  const filePath =
    designPath?.startsWith(`${designRoot}/`)
      ? designPath
      : pathname.startsWith("/public/fonts/")
        ? resolve(projectRoot, pathname.slice(1))
        : pathname.startsWith("/dist/")
          ? resolve(projectRoot, pathname.slice(1))
          : /^\/(?:assets|chunks|icons)\//.test(pathname) ||
              /^\/(?:preview|popup|offscreen|background|content)\.(?:html|js)$/.test(
                pathname
              )
            ? resolve(projectRoot, "dist", pathname.slice(1))
            : routeMap[pathname];

  if (!filePath || !existsSync(filePath)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": contentType(filePath),
    "Cache-Control": "no-store"
  });
  createReadStream(filePath).pipe(response);
}).listen(4178, "127.0.0.1");

function contentType(filePath) {
  switch (extname(filePath)) {
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".woff2":
      return "font/woff2";
    default:
      return "text/html; charset=utf-8";
  }
}
