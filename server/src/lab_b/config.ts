/** Additive Phase B contract. Nothing here owns /lab, /cover, /t or table/player routes. */
export const LAB_MENU = Object.freeze([
  { id: 'assemble', label: 'チップを組む' },
  { id: 'research', label: '研究と読み物' },
  { id: 'human', label: '人の工房' },
  { id: 'deposit', label: '預け窓口' },
] as const);
export type LabSection = typeof LAB_MENU[number]['id'];
export interface LabPaths {
  assemble: string; research: string; human: string; deposit: string; packages: string; assets: string;
}
export const DEFAULT_LAB_PATHS: Readonly<LabPaths> = Object.freeze({
  assemble:'/lab/assemble', research:'/lab/research', human:'/lab/human',
  deposit:'/lab/deposit', packages:'/lab/packages', assets:'/lab/assets',
});
export interface LabOptions {
  /** Use the supervisor's CURRENT room list. No room IDs or passwords are invented. */
  probeRoomIds: readonly string[];
  /** Source returned by the deployed Phase A watchSecretBrowserSource().
   * Passed by the host so we do not install/replace a second auth implementation. */
  watchSecretClientSource: string;
  /** Match existing /lab menu destinations when present, otherwise defaults above. */
  paths?: Partial<LabPaths>;
}
export interface LabConfig { probeRoomIds: string[]; watchSecretClientSource: string; paths: LabPaths; }
export function validateLabOptions(options: LabOptions): LabConfig {
  if (!options || !Array.isArray(options.probeRoomIds) || options.probeRoomIds.length>8 ||
      options.probeRoomIds.some(x=>typeof x!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(x)))
    throw new Error('Phase B requires 0–8 existing room IDs.');
  if(typeof options.watchSecretClientSource!=='string'||!options.watchSecretClientSource.trim()||
     options.watchSecretClientSource.length>100000||/<\/script/i.test(options.watchSecretClientSource))
    throw new Error('Pass the existing trusted MuseWatchSecret browser source.');
  if(options.paths!==undefined && (!options.paths || typeof options.paths!=='object' || Array.isArray(options.paths)))
    throw new Error('Invalid lab paths.');
  const paths: LabPaths={...DEFAULT_LAB_PATHS};
  for(const [key,value] of Object.entries(options.paths??{})) {
    if(!Object.hasOwn(paths,key)) throw new Error('Unknown lab route name.');
    // Only a single same-origin child segment; no credentials, query, fragments, escapes or slashes.
    if(typeof value!=='string'||!/^\/lab\/[a-z][a-z0-9-]{0,47}$/.test(value)) throw new Error('Routes must be distinct /lab/child paths.');
    paths[key as keyof LabPaths]=value;
  }
  if(new Set(Object.values(paths)).size!==Object.keys(paths).length) throw new Error('Duplicate lab route.');
  return { probeRoomIds:[...new Set(options.probeRoomIds)], watchSecretClientSource:options.watchSecretClientSource, paths };
}
export function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
}
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
}
