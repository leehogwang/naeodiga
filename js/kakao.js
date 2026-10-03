// 카카오맵 SDK를 키로 불러오는 공통 함수 (10초 안에 안 뜨면 TIMEOUT 에러)
window.loadKakaoMaps = (key, timeoutMs = 10000) => new Promise((resolve, reject) => {
  let timer = null;
  const done = (fn, v) => { clearTimeout(timer); fn(v); };
  const k = window.kakao && window.kakao.maps;
  if (k && k.LatLng) return resolve(k);
  if (!key && !(k && k.load)) return reject(new Error('NO_KEY'));
  timer = setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs);
  if (k && k.load) return k.load(() => done(resolve, window.kakao.maps));
  const s = document.createElement('script');
  s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false`;
  s.onload = () => {
    if (window.kakao && window.kakao.maps && window.kakao.maps.load) window.kakao.maps.load(() => done(resolve, window.kakao.maps));
    else done(reject, new Error('LOAD_FAIL'));
  };
  s.onerror = () => done(reject, new Error('LOAD_FAIL'));
  document.head.appendChild(s);
});
