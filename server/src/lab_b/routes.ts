import { validateLabOptions, type LabOptions, type LabConfig } from './config.ts';
import { LAB_ASSETS } from './assets.generated.ts';
import { labBPageResponse } from './pages.ts';
import { type PageId } from './content.ts';
export interface RouteMatch {kind:'page'|'asset';id:string;}
export function matchLabBPath(pathname:string,c:LabConfig):RouteMatch|null {
 for(const page of ['assemble','research','human','deposit','packages'] as const)if(pathname===c.paths[page])return {kind:'page',id:page};
 const asset=LAB_ASSETS.find(a=>pathname===c.paths.assets+'/'+a.filename);
 return asset?{kind:'asset',id:asset.id}:null;
}
export function labAssetResponse(id:string):Response {
 const a=LAB_ASSETS.find(a=>a.id===id);if(!a)throw new Error('Unknown bundled asset.');
 const data=Uint8Array.from(atob(a.base64),c=>c.charCodeAt(0));
 return new Response(data,{headers:{
  'Content-Type':a.contentType,'Content-Disposition':`attachment; filename="${a.filename}"`,
  'Content-Length':String(data.byteLength),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
  'X-Lab-Artifact-SHA256':a.sha256,
  // Downloads are public reference files, not private submissions. No same-origin active document.
  'Content-Security-Policy':"default-src 'none'; sandbox; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
 }});
}
/** Host calls this AFTER its exact /lab entrance route. null means continue existing routing.
 * No writes, network calls, DO bindings, credentials, live room state or player lifecycle changes.
 */
export function handleLabBRequest(request:Request,options:LabOptions):Response|null {
 const url=new URL(request.url);
 // Do not even validate host settings for unrelated routes.
 if(!url.pathname.startsWith('/lab/'))return null;
 const cfg=validateLabOptions(options);const match=matchLabBPath(url.pathname,cfg);if(!match)return null;
 if(request.method!=='GET'&&request.method!=='HEAD')return new Response('Method not allowed',{status:405,headers:{Allow:'GET, HEAD','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 const response=match.kind==='page'?labBPageResponse(match.id as PageId,options):labAssetResponse(match.id);
 return request.method==='HEAD'?new Response(null,{status:response.status,headers:response.headers}):response;
}
export {DEFAULT_LAB_PATHS,LAB_MENU} from './config.ts';
export type {LabOptions,LabPaths} from './config.ts';
