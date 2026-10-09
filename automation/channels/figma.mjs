// 피그마 채널 — 메뉴판 자동화 플러그인(automation/figma-plugin)에 명령을 보낸다.
// 피그마 메뉴판이 메뉴 상태의 기준(source of truth)이다.

const req = (bridge, cmd, args, onProgress) => bridge.call(cmd, args, { timeout: 120000, onProgress });

export function figmaChannel(bridge) {
  // 활성화(live)일 때 opts.badges: 다시 붙일 NEW/best (기본 없음)
  const move = (to) => (name, opts = {}) => req(bridge, 'move', { name, to, badges: opts.badges || [] }, opts.onProgress);
  return {
    key: 'figma',
    name: '피그마',
    add: (name, desc, opts = {}) => req(bridge, 'add', { name, desc, badges: [...(opts.new ? ['NEW'] : []), ...(opts.best ? ['best'] : [])] }, opts.onProgress),
    restore: move('live'),
    soldout: move('soldout'),
    seasonoff: move('seasonoff'),
    later: move('later'),
    setDesc: (name, desc, opts = {}) => req(bridge, 'setDesc', { name, desc }, opts.onProgress),
    setBadge: (name, badge, on, opts = {}) => req(bridge, 'setBadge', { name, badge, on }, opts.onProgress),
    setDelivery: (name, off, opts = {}) => req(bridge, 'setDelivery', { name, off }, opts.onProgress),
    snapshot: () => req(bridge, 'snapshot', {}),
    tidy: (opts = {}) => req(bridge, 'tidy', {}, opts.onProgress),
  };
}
