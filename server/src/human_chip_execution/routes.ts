import {bodyJson} from '../lab_c/portable.js';
import {workshopId,integer,secret,json,HttpError,failure,keys} from '../lab_c/contracts.js';
import {ExecutionError,type Principal} from './contracts.js';
import {BindingService} from './bindings.js';
export interface BindingRouteOptions {
 /** Authenticate by existing RoomDO participant token. Never trust a seat in body/query. */
 authenticateParticipant(request:Request):Promise<Principal|null>|Principal|null;
 bindings:BindingService;
 /** Trusted public origin if Worker forwarded this request under an internal URL. Never derive from client headers. */
 publicOrigin?:string;
}
/** Delegate ONLY /rooms/{currentRoomId}/human-chip to this RoomDO handler. No lab/cover/player replacement. */
export async function handleBindingRequest(request:Request,options:BindingRouteOptions):Promise<Response> {
 try{
  const url=new URL(request.url),origin=request.headers.get('Origin');
  const expectedOrigin=options.publicOrigin===undefined?url.origin:new URL(options.publicOrigin).origin;
  if(origin!==null&&origin!==expectedOrigin)throw new HttpError(403,'ORIGIN','同一オリジンから操作してください');
  if([...url.searchParams].length)throw new HttpError(400,'QUERY','鍵や席番号をURLへ入れないでください');
  if(!['GET','POST','DELETE'].includes(request.method))throw new HttpError(405,'METHOD','GET/POST/DELETE only');
  if(request.method!=='GET'&&request.headers.get('X-Lab-Client')!=='human-workshop-v1')throw new HttpError(403,'CLIENT_HEADER','人の席の操作が必要です');
  const principal=await options.authenticateParticipant(request);
  if(!principal||principal.kind!=='human')throw new HttpError(403,'PARTICIPANT_REQUIRED','着席中の本人資格が必要です');
  if(request.method==='GET')return json({binding:options.bindings.forParticipant(principal)});
  if(request.method==='DELETE'){options.bindings.unbind(principal);return json({binding:null,mode:'manual'});}
  const body=await bodyJson(request);keys(body,['workshop_id','version']);
  return json({binding:await options.bindings.bind(principal,workshopId(body.workshop_id),integer(body.version,1,100,'version'),secret(request.headers.get('X-Lab-Owner-Key')))});
 }catch(e){return e instanceof ExecutionError?json({error:e.code},e.status):failure(e);}
}
