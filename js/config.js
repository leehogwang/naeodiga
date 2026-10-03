// 캠퍼스 길찾기 설정 파일
// kakaoKey, supabaseUrl, supabaseKey는 비워 둡니다. 실제 값은 js/config.local.js(git 제외)에 넣어요. js/config.local.example.js 참고
window.CAMPUS_CONFIG = {
  kakaoKey: '',                       // 예: 'a1b2c3d4e5...'
  campusName: '건국대 글로컬캠퍼스',      // 데이터의 건물 이름으로 추정한 이름이에요. 다르면 고쳐 주세요
  mapCenter: [36.94958, 127.90852],     // 처음 보여줄 위치 [위도, 경도] (건물 데이터의 중심)
  dataUrl: 'data/campus.geojson',     // 편집기에서 저장한 파일을 이 경로에 두고 배포
  walkSpeed: 1.35,                    // 걷는 속도 (m/s). 현장 테스트 7회 실측 중간값
  gpsGoodAccuracy: 20,                // GPS 오차가 이 값(m) 이하면 "정확"으로 표시
  gpsMaxAccuracy: 100,                // 이 값(m)보다 나쁘면 GPS를 출발점으로 쓰지 않음
  arriveRadius: 15,                   // 입구까지 이 거리(m) 안이면 도착 (GPS 실측 95% 오차 중간값 11.5m 반영)
  turnAnnounce: 15,                   // 꺾는 곳 이 거리(m) 앞에서 음성 안내
  offRouteDistance: 15,               // 경로에서 이만큼(m) 벗어난 상태가 두 번 연속이면 경로를 다시 찾음
  offCampusDistance: 300,             // 가장 가까운 캠퍼스 길에서 이만큼(m) 떨어지면 캠퍼스 밖으로 판단
  floorChange: 2.5,                   // 실내 AR 층 감지: 이만큼(m) 올라가거나 내려가면 한 층 이동
  floorHeight: 3.5,                   // 그다음 층부터는 층고(m)마다 한 층 (과기대 3D 실측 3.45~3.6m)
  // 호실 위치(route_nodes)를 읽어 올 Supabase. publishable 키는 브라우저 공개용이에요
  supabaseUrl: '',
  supabaseKey: '',
};
