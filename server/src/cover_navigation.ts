/** Add once per existing page, outside any hidden authentication/table container. */
export const COVER_RETURN_LINK = '<nav class="muse-cover-return" aria-label="表紙への案内"><a href="/cover">表紙へ戻る</a></nav>';
/** Append inside the page's EXISTING style element; no global body/a overrides. */
export const COVER_RETURN_STYLE = `
.muse-cover-return{display:flex;justify-content:flex-end;box-sizing:border-box;padding:10px 16px;position:relative;z-index:1}
.muse-cover-return a{display:inline-flex;align-items:center;min-height:44px;padding:0 12px;border:1px solid currentColor;border-radius:5px;color:inherit;font:inherit;font-size:14px;text-decoration:underline;text-underline-offset:3px}
.muse-cover-return a:focus-visible{outline:3px solid currentColor;outline-offset:3px}
`;
