import { extname, resolve, sep } from "node:path";
import { ApiError } from "./http";

export async function serveStatic(request:Request,dist:string):Promise<Response> {
  if(request.method!=="GET"&&request.method!=="HEAD") throw new ApiError(405,"method_not_allowed","Method not allowed");
  const encoded=new URL(request.url).pathname;
  let pathname:string; try { pathname=decodeURIComponent(encoded); } catch { throw new ApiError(400,"invalid_path","Malformed URL encoding"); }
  if(pathname.includes("\0")||pathname.includes("\\")||pathname.includes("%")) throw new ApiError(400,"invalid_path","Invalid path");
  const root=resolve(dist); const candidate=resolve(root,`.${pathname}`);
  if(candidate!==root&&!candidate.startsWith(root+sep)) throw new ApiError(404,"not_found","File not found");
  const file=Bun.file(candidate); if(await file.exists()&&file.size>0) return new Response(request.method==="HEAD"?null:file,{headers:{"content-type":file.type||"application/octet-stream"}});
  // SPA fallback for GET/HEAD outside /api/ and non-extension paths, regardless of Accept.
  // An unknown extensionless route still gets index.html; render-status, not the HTTP code, proves route truth.
  if(pathname.startsWith("/api/")||extname(pathname)) throw new ApiError(404,"not_found","File not found");
  const index=Bun.file(resolve(root,"index.html")); if(!await index.exists()) throw new ApiError(404,"not_found","File not found");
  return new Response(request.method==="HEAD"?null:index,{headers:{"content-type":"text/html; charset=utf-8"}});
}
