// ===== 캠퍼스 챗봇 엔진 (외부 API 없이 브라우저에서 동작) =====
// 1) 문장 정리: 조사 떼기, 공백·기호 정리
// 2) 건물 찾기: 이름·별칭·건물 번호 포함 여부 → 초성 검색 → 자모 단위 오타 허용
// 3) 의도 분류: 길찾기, 운영시간, 층, 입구, 휠체어·엘리베이터, 편의시설, 인사, 도움말
// 4) 맥락 유지: "거기 몇 시까지 해?"처럼 앞에서 말한 건물을 이어받음
// 5) 답변은 등록된 데이터로만 만듦 (없는 정보는 없다고 말함)
const CampusBot = (() => {
  const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
  const JONG = ' ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ';
  const isHangul = (c) => { const k = c.charCodeAt(0) - 0xac00; return k >= 0 && k < 11172; };
  const toCho = (s) => [...s].map((c) => (isHangul(c) ? CHO[Math.floor((c.charCodeAt(0) - 0xac00) / 588)] : c)).join('');
  const toJamo = (s) => [...s].map((c) => {
    if (!isHangul(c)) return c;
    const k = c.charCodeAt(0) - 0xac00;
    return CHO[Math.floor(k / 588)] + JUNG[Math.floor((k % 588) / 28)] + (k % 28 ? JONG[k % 28] : '');
  }).join('');
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-_.·,!?~'"()\[\]]/g, '');

  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  // 자모 단위로 비교해서 받침 하나 틀린 정도는 같은 말로 봄 (0이면 같음, 1이면 완전히 다름)
  const jamoDist = (a, b) => { const A = toJamo(a), B = toJamo(b); return lev(A, B) / Math.max(A.length, B.length, 1); };

  // 끝에 붙는 조사·어미 떼기
  const TAILS = ['으로부터', '에서부터', '이에요', '인가요', '입니까', '까지는', '에서는', '한테', '에게', '에서', '으로', '까지', '부터', '이야', '예요', '이요', '이랑', '은', '는', '이', '가', '을', '를', '에', '로', '도', '야', '요', '랑', '과', '와', '의'];
  function stripTail(tok) {
    for (let k = 0; k < 2; k++) {
      const t = TAILS.find((x) => tok.length > x.length && tok.endsWith(x));
      if (!t) break;
      tok = tok.slice(0, -t.length);
    }
    return tok;
  }
  const rawTokens = (text) => String(text || '').toLowerCase().replace(/[!?~.,'"()]/g, ' ').split(/\s+/).filter(Boolean);
  const tokens = (text) => rawTokens(text).map(stripTail).filter(Boolean);

  // ---------- 의도 ----------
  const FACILITIES = {
    카페: ['카페', '커피'], 편의점: ['편의점', '매점', 'gs25', 'cu', '세븐일레븐'], 식당: ['식당', '학식', '밥', '구내식당', '푸드코트'],
    프린터: ['프린터', '프린트', '인쇄', '복사', '출력'], 화장실: ['화장실'], 열람실: ['열람실', '공부할', '스터디'],
    ATM: ['atm', '현금인출', '은행'], 자판기: ['자판기'], 주차장: ['주차', '주차장'], 흡연구역: ['흡연'],
  };
  const INTENTS = [
    ['greet', /^(안녕|하이|hi|hello|ㅎㅇ|반가)/],
    ['thanks', /(고마|감사|땡큐|thx|thanks|ㄱㅅ)/],
    ['help', /(도움말|사용법|뭐\s*할\s*수|뭘\s*물어|무엇을|어떻게\s*써|기능)/],
    ['access', /(휠체어|엘리베이터|엘베|계단\s*없|경사로|장애|무거운\s*짐|캐리어)/],
    ['hours', /(몇\s*시|언제\s*(열|닫|까지)|열어|열려|열었|닫아|닫혀|닫았|운영|영업|오픈|마감|시간)/],
    ['floors', /(몇\s*층|층수|몇층|\d+\s*층|지하|\d{3,4}\s*호|[bB]\d{2,3})/],
    ['entrance', /(입구|출입구|정문|후문|들어가는\s*곳|어디로\s*들어)/],
    ['floorlist', /(층별|층\s*안내|안내도|층마다|각\s*층)/],
    ['info', /(뭐\s*있|무슨\s*건물|어떤\s*건물|소개|정보|알려\s*줘)/],
    ['route', /(어디|가는\s*(길|법)|가려면|가고\s*싶|길\s*(좀|알려|찾)|어떻게\s*가|데려|안내|찾아|위치)/],
  ];
  // 영문 3글자 이하(cu, atm)는 단어 전체가 같을 때만 인정 (K-CUBE 속 'cu' 오인식 방지)
  const shortLatin = (w) => /^[a-z0-9]{1,3}$/.test(w);
  const wordsOf = (x) => String(x).toLowerCase().split(/[^a-z0-9가-힣]+/).filter(Boolean);
  function synHit(text, w) { return shortLatin(w) ? wordsOf(text).includes(w) : norm(text).includes(norm(w)); }
  function detectFacility(text) {
    for (const [name, words] of Object.entries(FACILITIES)) if (words.some((w) => synHit(text, w))) return name;
    return null;
  }
  function detectRoom(text) {
    const m = String(text).match(/([bB]|지하\s*)?(\d)(\d{2})\s*호/) || String(text).match(/\b([bB])(\d)(\d{2})\b/);
    if (m) return { room: m[0].replace(/\s/g, ''), floor: m[1] ? -Number(m[2]) : Number(m[2]) };
    // "상허 209"처럼 '호' 없이 세 자리 숫자만 써도 호실로 봄
    const n = String(text).match(/(?:^|\s)(\d)(\d{2})(?=\s|\?|$)/);
    if (n) return { room: `${n[1]}${n[2]}호`, floor: Number(n[1]) };
    const f = String(text).match(/(지하\s*)?(\d+)\s*층/);
    if (f) return { room: null, floor: f[1] ? -Number(f[2]) : Number(f[2]) };
    return null;
  }

  // ---------- 건물 찾기 ----------
  function namesOf(b) { return [b.props.name, b.props.code, ...(b.props.aliases || [])].filter(Boolean).map(String); }
  // 건물 종류를 부르는 말 → 건물 이름에 흔히 들어가는 말
  const CATEGORY = { 기숙사: ['학사', '생활관', '기숙사', '레지던스'], 생활관: ['생활관', '학사'], 체육관: ['체육관', '스포츠'], 운동장: ['운동장', '스타디움', '스터디움'], 본관: ['본관', '행정관'] };
  function findBuildings(text, buildings) {
    const t = norm(text);
    const cat = Object.keys(CATEGORY).find((k) => t.includes(k));
    if (cat) {
      const hit = buildings.filter((b) => namesOf(b).some((nm) => CATEGORY[cat].some((w) => norm(nm).includes(w))));
      const direct = buildings.filter((b) => namesOf(b).some((nm) => norm(nm) === cat || (cat.length >= 3 && norm(nm).includes(cat))));
      if (hit.length && !direct.length) return hit.map((b) => ({ b, score: 0.7, how: 'partial', cat }));
    }
    // 조사를 뗀 단어와 원래 단어를 둘 다 봄 ("중도"의 '도'를 조사로 잘못 떼는 경우 대비)
    const toks = [...new Set([...tokens(text), ...rawTokens(text)])];
    const cands = [];
    buildings.forEach((b) => {
      let best = 0, how = '';
      namesOf(b).forEach((nm) => {
        const n = norm(nm); if (!n) return;
        // 1) 문장 안에 이름이 그대로 들어 있음 (긴 이름일수록 확실)
        // 짧은 별칭(예: 학관)이 다른 단어(제3공학관) 속에 우연히 들어 있는 경우를 막기 위해,
        // 4글자 이상은 문장 포함, 그보다 짧으면 단어(조사 뗀 것) 단위로 같아야 인정
        const st = tokens(text), rt = rawTokens(text);
        const grams0 = [...toks, ...st.slice(0, -1).map((x, i) => x + st[i + 1]), ...rt.slice(0, -1).map((x, i) => x + rt[i + 1])];
        if ((n.length >= 4 && t.includes(n)) || grams0.includes(n)) { const s = 0.9 + Math.min(n.length, 10) / 100; if (s > best) { best = s; how = 'exact'; } }
        if (/^\d+$/.test(n) && toks.includes(n)) { if (0.85 > best) { best = 0.85; how = 'code'; } }
        // 2) 초성으로 입력 (예: ㅈㅇㄷㅅㄱ)
        toks.forEach((tk) => { if (/^[ㄱ-ㅎ]{2,}$/.test(tk) && toCho(n).includes(tk) && tk.length >= Math.min(3, n.length)) { const s = 0.75; if (s > best) { best = s; how = 'chosung'; } } });
        // 3) 오타 허용 (자모 편집 거리)
        if (n.length >= 2) {
          const grams = [...toks, ...toks.slice(0, -1).map((x, i) => x + toks[i + 1])];
          grams.forEach((g) => {
            if (g.length < 3 || /^[ㄱ-ㅎ]+$/.test(g)) return; // 두 글자는 오타 허용 안 함 (학관 ≠ 의학관)
            const digits = (x) => (x.match(/\d/g) || []).join('');
            if (digits(g) !== digits(n)) return; // 숫자가 다르면 다른 건물 (제1공학관 ≠ 제3공학관)
            const d = jamoDist(g, n);
            const s = 1 - d;
            if (d <= 0.25 && s * 0.8 > best) { best = s * 0.8; how = 'fuzzy'; }
          });
        }
      });
      // 4) 이름의 일부만 말함 (도서관 → 중원도서관, 공학관 → 제1공학관)
      namesOf(b).forEach((nm) => {
        const n = norm(nm);
        toks.forEach((tk) => {
          if (tk.length < 2 || STOP.has(tk) || /^\d+$/.test(tk) || /^[ㄱ-ㅎ]+$/.test(tk) || n.length <= tk.length) return;
          const s = n.includes(tk) ? 0.6 + (tk.length / n.length) * 0.2 : isAbbrev(tk, n) ? 0.62 : 0; // 인문관 → 인문사회관
          if (!s) return;
          if (s > best) { best = s; how = 'partial'; }
        });
      });
      if (best > 0) cands.push({ b, score: best, how });
    });
    return cands.sort((a, b) => b.score - a.score);
  }
  // 못 찾았을 때 "혹시 이건가요?" 후보
  function suggest(text, buildings, k = 3) {
    const toks = tokens(text).filter((x) => x.length >= 2);
    if (!toks.length) return [];
    return buildings.map((b) => {
      let best = 1;
      namesOf(b).forEach((nm) => toks.forEach((tk) => { best = Math.min(best, jamoDist(tk, norm(nm))); }));
      return { b, d: best };
    }).filter((x) => x.d <= 0.5).sort((a, b) => a.d - b.d).slice(0, k).map((x) => x.b);
  }

  // ---------- 층별 안내(시설) 검색 ----------
  // 건물 데이터의 floor_info: [{ floor: 3, items: ['컴퓨터공학과 과사무실', '강의실 301~310'] }, ...]
  const STOP = new Set(['어디', '어디야', '어딨어', '어디에', '몇', '몇층', '층', '있어', '있나', '있니', '있는', '가는', '가는길', '길', '알려줘', '알려', '줘', '좀', '위치', '어떻게', '뭐', '뭐가', '무엇', '찾아', '근처', '가까운', '제일', '곳', '건물', '안에', '안', '여기', '거기', '그', '가고', '싶어', '해', '하는', '돼', '되나', '어느', '쪽']);
  const floorLabel = (f) => (Number(f) < 0 ? `지하 ${-Number(f)}층` : `${f}층`);
  function floorRows(b) {
    return (b.props.floor_info || [])
      .filter((r) => r && r.floor !== '' && r.floor != null && Number.isFinite(Number(r.floor)))
      .map((r) => ({ floor: Number(r.floor), items: (r.items || []).filter(Boolean) }))
      .sort((a, c) => a.floor - c.floor);
  }
  // 문장에서 시설 이름을 찾아 어느 건물 몇 층인지 반환
  function itemHits(text, buildings, onlyB, buildingWords) {
    const fac = detectFacility(text);
    const toks = [...new Set([...tokens(text), ...rawTokens(text)])]
      .map(norm)
      .filter((t) => t.length >= 2 && !STOP.has(t) && !/^[bB]?\d+(층|호)?$/.test(t) && !buildingWords.has(t) && ![...buildingWords].some((w) => w.includes(t)));
    const hits = [];
    buildings.forEach((b) => {
      if (onlyB && b.id !== onlyB.id) return;
      const rows = [...floorRows(b).flatMap((r) => r.items.map((it) => ({ floor: r.floor, item: it }))), ...(b.props.facilities || []).map((it) => ({ floor: null, item: it }))];
      rows.forEach((r) => {
        const n = norm(r.item); if (!n) return;
        let score = 0;
        const words = String(r.item).toLowerCase().split(/\s+/).map(norm).filter(Boolean);
        toks.forEach((t) => {
          if (shortLatin(t) ? wordsOf(r.item).includes(t) : n.includes(t)) score += 1 + (0.1 * t.length) / Math.max(n.length, 1); // 글자가 들어 있으면 거의 같은 점수 (과사무실 → 모든 학과사무실)
          else if (words.some((w) => isAbbrev(t, w))) score += 0.5; // 컴공 → 컴퓨터공학과, 전자과 → 전자공학과
          else if (t.length >= 3 && jamoDist(t, n) <= 0.25) score += 0.6;
        });
        if (fac && FACILITIES[fac].some((w) => synHit(r.item, w))) score = Math.max(score, 1);
        if (score > 0) hits.push({ b, floor: r.floor, item: r.item, score });
      });
    });
    hits.sort((a, c) => c.score - a.score);
    if (!hits.length) return [];
    const top = hits[0].score;
    // 가장 잘 맞은 것과 비슷한 점수만 남기고, 같은 건물에서 층 정보가 있는 쪽을 우선
    const kept = hits.filter((h) => h.score >= top * 0.75);
    return kept.filter((h) => !(h.floor == null && kept.some((x) => x.b.id === h.b.id && x.floor != null)));
  }
  // 줄임말: 첫 글자가 같고 나머지 글자가 순서대로 들어 있으면 같은 말로 봄
  function isAbbrev(t, w) {
    if (t.length < 2 || t.length > 4 || t.length >= w.length || !/^[가-힣]+$/.test(t) || t[0] !== w[0]) return false;
    let i = 0;
    for (const c of w) if (c === t[i]) i++;
    return i === t.length;
  }
  // "공대 305호"가 "강의실 301~310" 같은 범위에 들어가는지
  function roomInRange(b, roomNo) {
    for (const r of floorRows(b)) for (const it of r.items) {
      const m = String(it).match(/(\d{3,4})\s*[~\-–]\s*(\d{3,4})/);
      if (m && roomNo >= +m[1] && roomNo <= +m[2]) return { floor: r.floor, item: it };
      if (new RegExp(`(^|\\D)${roomNo}(\\D|$)`).test(String(it))) return { floor: r.floor, item: it };
    }
    return null;
  }

  // ---------- 단계별 길 안내 문장 ----------
  // 경로를 단계별 안내로 바꿈
  // - 갈림길(연결된 길 3개 이상)에서 40° 이상 꺾일 때만 '꺾기'로 봄
  // - 갈림길이 아닌 곳은 100° 이상 급하게 꺾일 때만 (그 외에는 길을 따라 휘어지는 것이라 안내하지 않음)
  // - 꺾는 각도는 그 지점 앞뒤 10m 방향으로 계산
  // opts.degs: 각 점에 연결된 길 수 (없으면 모든 점을 갈림길로 봄)
  function directions(line, opts = {}) {
    if (!line || line.length < 2) return [];
    const pj = CampusCore.makeProjection(line[0][1], line[0][0]);
    const P = line.map(pj.fwd);
    const degs = opts.degs && opts.degs.length === line.length ? opts.degs : null;
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    const total = cum.at(-1);
    if (total < 0.5) return [];
    const ptAt = (d) => {
      d = Math.max(0, Math.min(total, d));
      let k = 1; while (k < cum.length - 1 && cum[k] < d) k++;
      const seg = cum[k] - cum[k - 1] || 1, t = (d - cum[k - 1]) / seg;
      return [P[k - 1][0] + (P[k][0] - P[k - 1][0]) * t, P[k - 1][1] + (P[k][1] - P[k - 1][1]) * t];
    };
    const brgOf = (a, b) => (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
    const W = 10;
    const angleAt = (dist) => {
      const here = ptAt(dist), before = ptAt(dist - W), ahead = ptAt(dist + W);
      if (Math.hypot(here[0] - before[0], here[1] - before[1]) < 2 || Math.hypot(ahead[0] - here[0], ahead[1] - here[1]) < 2) return 0;
      const d = brgOf(here, ahead) - brgOf(before, here); return ((d + 540) % 360) - 180;
    };
    // 1) 꺾기 후보
    let cands = [];
    for (let i = 1; i < P.length - 1; i++) {
      const a = angleAt(cum[i]), junction = degs ? degs[i] >= 3 : true;
      if ((junction && Math.abs(a) >= 40) || Math.abs(a) >= 100) cands.push({ i, d: cum[i], a });
    }
    // 2) 3m 안에 붙은 후보는 하나로 (더 크게 꺾이는 쪽)
    const merged = [];
    cands.forEach((c) => { const last = merged.at(-1); if (last && c.d - last.d < 3) { if (Math.abs(c.a) > Math.abs(last.a)) merged[merged.length - 1] = c; } else merged.push(c); });
    // 3) 단계 만들기
    const r10 = (m) => (m < 15 ? Math.max(5, Math.round(m / 5) * 5) : Math.round(m / 10) * 10);
    const out = [];
    const firstLen = merged.length ? merged[0].d : total;
    out.push({ text: `${r10(firstLen)}m 직진해요`, turn: 'start', dist: firstLen, at: line[0], angle: 0 });
    merged.forEach((c, k) => {
      const len = (k + 1 < merged.length ? merged[k + 1].d : total) - c.d;
      const ad = Math.abs(c.a), side = c.a > 0 ? '오른쪽' : '왼쪽';
      const turn = ad < 60 ? `slight-${c.a > 0 ? 'r' : 'l'}` : ad < 135 ? (c.a > 0 ? 'right' : 'left') : 'uturn';
      const verb = ad < 60 ? `살짝 ${side}으로` : ad < 135 ? `${side}으로 꺾어서` : '뒤로 돌아서';
      out.push({ text: `${verb} ${r10(len)}m 가요`, turn, dist: len, at: pj.inv(P[c.i]), angle: c.a, along: c.d });
    });
    if (opts.arrive) out.push({ text: opts.arrive, turn: 'arrive', dist: 0, at: line.at(-1), angle: 0, along: total });
    return out;
  }

  // ---------- 답변 만들기 ----------
  const ENT = { main: '정문', side: '보조 출입구', stairs: '계단 출입구', elevator: '엘리베이터 출입구', parking: '주차장 연결 출입구' };
  const nm = (b) => `「${b.props.name || '이름 없는 건물'}」`;
  const josa = (word, a, b) => { const c = String(word).at(-1); if (!c || !isHangul(c)) return a; return (c.charCodeAt(0) - 0xac00) % 28 ? a : b; };
  const bname = (b) => b.props.name || '이름 없는 건물';

  function create(data) {
    const buildings = data.buildings, entrances = data.entrances;
    const entsOf = (bid) => entrances.filter((e) => e.props.building_id === bid);
    // DB에서 수집한 실내 노드(앵커 제외). 나중에 채워지는 배열이라 그때그때 읽음. 건물은 코드(U10 등)로 연결
    const nodes = data.nodes || [];
    const roomNode = (b, roomText) => {
      const no = String(roomText).replace(/\D/g, ''), re = new RegExp(`(^|\\D)${no}(\\D|$)`);
      return nodes.find((n) => n.building && namesOf(b).includes(n.building.code) && re.test(n.name || ''));
    };
    const ctx = { building: null, lastIntent: null };

    function hoursText(b) {
      const lines = [];
      if (b.props.hours) lines.push(`${nm(b)} 운영시간은 ${b.props.hours}이에요.`);
      const es = entsOf(b.id);
      const withH = es.filter((e) => e.props.open_hours);
      if (withH.length) {
        lines.push(withH.map((e) => `${ENT[e.props.type] || '출입구'} ${e.props.open_hours} (지금 ${CampusCore.isOpenNow(e.props.open_hours) ? '열림' : '닫힘'})`).join(', ') + '.');
        const always = es.length - withH.length;
        if (always) lines.push(`나머지 출입구 ${always}곳은 시간 제한이 등록돼 있지 않아요.`);
      }
      if (!lines.length) return `${nm(b)}의 운영시간은 등록돼 있지 않아요. 출입구는 항상 열린 것으로 안내하고 있어요.`;
      return lines.join(' ');
    }
    function floorsText(b, room) {
      const parts = [];
      const roomNo = room && room.room ? Number(String(room.room).replace(/\D/g, '')) : null;
      const inRange = roomNo ? roomInRange(b, roomNo) : null;
      if (inRange) {
        parts.push(`${room.room}는 ${floorLabel(inRange.floor)}에 있어요 (${inRange.item}).`);
        if (inRange.floor >= 3 && entsOf(b.id).some((e) => e.props.type === 'elevator')) parts.push('엘리베이터 출입구로 들어가면 편해요.');
        return parts.join(' ');
      }
      if (room && room.floor != null && !room.room && floorRows(b).length) return floorListText(b, room.floor);
      if (room && room.floor != null) {
        const f = room.floor < 0 ? `지하 ${-room.floor}층` : `${room.floor}층`;
        parts.push(`${room.room ? `${room.room}는 보통 ` : ''}${f}에 있어요.`);
        const sameFloor = entsOf(b.id).filter((e) => Number(e.props.floor) === room.floor);
        if (sameFloor.length) parts.push(`${f}로 바로 들어가는 ${ENT[sameFloor[0].props.type] || '출입구'}가 있어요.`);
        else if (entsOf(b.id).some((e) => e.props.type === 'elevator')) parts.push('엘리베이터 출입구로 들어가면 편해요.');
      }
      if (b.props.floors) parts.push(`${nm(b)}${josa(bname(b), '은', '는')} ${b.props.floors}이에요.`);
      if (!parts.length) return `${nm(b)}의 층 정보는 등록돼 있지 않아요.`;
      if (room && room.room) parts.push('강의실 번호의 첫 자리를 층으로 본 추정이라, 건물마다 다를 수 있어요.');
      return parts.join(' ');
    }
    function floorListText(b, f) {
      const rows = floorRows(b);
      const row = rows.find((r) => r.floor === f);
      if (row && row.items.length) {
        const shown = row.items.length > 10 ? [...row.items.slice(0, 10), `그 밖에 ${row.items.length - 10}곳`] : row.items;
        return `${nm(b)} ${floorLabel(f)}에는 ${shown.join(', ')}${josa(shown.at(-1), '이', '가')} 있어요.`;
      }
      if (!rows.length) return `${nm(b)}의 층별 안내는 아직 등록돼 있지 않아요.`;
      return `${nm(b)} ${floorLabel(f)} 정보는 없어요. 등록된 층은 ${rows.map((r) => floorLabel(r.floor)).join(', ')}이에요.`;
    }
    // 층별 안내를 화면에 표로 그릴 수 있게 [{ label: '1층', items: [...] }] 형태로 돌려줌
    function floorList(b) {
      return floorRows(b).filter((r) => r.items.length).map((r) => ({ floor: r.floor, label: floorLabel(r.floor), items: r.items }));
    }
    function allFloorsText(b) { // 글자만 보여 줄 때(표를 못 그릴 때) 쓰는 줄바꿈 버전
      const rows = floorList(b);
      return rows.length ? rows.map((r) => `${r.label}: ${r.items.join(', ')}`).join('\n') : '';
    }
    function entranceText(b) {
      const es = entsOf(b.id);
      if (!es.length) return `${nm(b)}에는 아직 등록된 출입구가 없어요.`;
      return `${nm(b)} 출입구는 ${es.length}곳이에요. ` + es.map((e) => `${ENT[e.props.type] || '출입구'}${e.props.floor !== '' && e.props.floor != null ? `(${e.props.floor}층)` : ''}${e.props.note ? `: ${e.props.note}` : ''}`).join(', ') + '.';
    }
    function accessText(b) {
      const es = entsOf(b.id);
      const ok = es.filter((e) => e.props.type !== 'stairs' && e.props.accessible !== false);
      const elev = es.filter((e) => e.props.type === 'elevator');
      if (!es.length) return `${nm(b)}에는 아직 등록된 출입구가 없어요.`;
      if (!ok.length) return `${nm(b)}에는 계단 없이 들어갈 수 있는 출입구가 등록돼 있지 않아요.`;
      return `${nm(b)}에 계단 없이 들어갈 수 있는 출입구가 ${ok.length}곳 있어요${elev.length ? ` (엘리베이터 출입구 ${elev.length}곳 포함)` : ''}. 계단을 피하는 길로 안내할게요.`;
    }
    function infoText(b) {
      const p = b.props, bits = [];
      if (p.desc) bits.push(p.desc);
      if (p.floors) bits.push(`층: ${p.floors}`);
      if (p.hours) bits.push(`운영: ${p.hours}`);
      if (p.facilities && p.facilities.length) bits.push(`편의시설: ${p.facilities.join(', ')}`);
      bits.push(`출입구 ${entsOf(b.id).length}곳`);
      if (p.memo) bits.push(p.memo);
      return `${nm(b)}${(p.aliases || []).length ? ` (${p.aliases.join(', ')})` : ''}\n${bits.join('\n')}`;
    }
    const floorsHead = (b) => (floorList(b).length ? `\n\n층별 안내` : '');
    const routeAct = (b, access) => ({ label: access ? '계단 없이 길찾기' : '길찾기', action: 'route', bid: b.id, avoidStairs: !!access });

    function reply(text) {
      const raw = String(text || '').trim();
      if (!raw) return { text: '궁금한 건물이나 장소를 말해 주세요.', actions: [] };
      let intent = (INTENTS.find(([, re]) => re.test(raw)) || [null])[0];
      const facility = detectFacility(raw);
      const room = detectRoom(raw);
      const found = findBuildings(raw, buildings);
      const pronoun = /(거기|그\s*건물|그곳|그쪽|저기|여기)/.test(raw);
      // "공학관 어디야?"처럼 이름 일부가 여러 건물에 맞으면 되물어 봄
      if (found.length > 1 && found[0].how === 'partial' && found[1].how === 'partial' && found[0].score - found[1].score < 0.1) {
        const opts = found.filter((x) => x.how === 'partial' && found[0].score - x.score < 0.1).slice(0, 5);
        const word = found[0].cat || tokens(raw).find((t) => opts.every((o) => namesOf(o.b).some((n) => norm(n).includes(norm(t)))));
        return { text: found[0].cat ? `${word}${josa(word, '은', '는')} ${opts.length}곳이에요. 어디를 말하는 건가요?`
          : word ? `"${word}"${josa(word, '이', '가')} 들어간 건물이 ${opts.length}곳이에요. 어디를 말하는 건가요?` : `비슷한 이름의 건물이 ${opts.length}곳이에요. 어디를 말하는 건가요?`,
          actions: opts.map((o) => ({ label: bname(o.b), action: 'ask', text: raw.replace(/\S*$/, '').trim() ? `${bname(o.b)} ${raw.split(/\s+/).slice(1).join(' ')}`.trim() : `${bname(o.b)} 어디야?` })), intent: 'clarify' };
      }
      let b = found[0]?.b || null;
      const fuzzyOnly = found[0] && found[0].how === 'fuzzy';
      if (!b && (pronoun || (intent && intent !== 'route' && ctx.building))) b = ctx.building;

      if (intent === 'greet' && !b) return { text: `안녕하세요! 캠퍼스 건물 위치, 운영시간, 층, 출입구를 알려 드려요. 예를 들어 "도서관 어디야?"라고 물어보세요.`, actions: [], intent };
      if (intent === 'thanks') return { text: '도움이 됐다니 다행이에요. 또 궁금한 곳이 있으면 물어보세요.', actions: [], intent };
      if (intent === 'help') return { text: '이런 걸 물어볼 수 있어요. "공대 어디야?", "도서관 몇 시까지 해?", "학생회관 엘리베이터 있어?", "305호 몇 층이야?", "과사무실 어디야?", "도서관 3층에 뭐 있어?", "카페 어디 있어?" 건물 이름은 줄임말이나 초성(ㅈㅇㄷㅅㄱ)으로 써도 돼요.', actions: [], intent };

      // 층별 안내에 적힌 시설 찾기 ("과사무실 어디야?", "공대 프린터 몇 층?")
      const bWords = new Set(found.flatMap((x) => namesOf(x.b).map(norm)));
      const scopeB = found[0]?.b || (pronoun ? ctx.building : null);
      const askFloorList = /(뭐|무엇|무슨|어떤).*(있|해)/.test(raw) || /층에는\??$|층은\??$/.test(raw.replace(/\s/g, ''));
      if (!askFloorList && !['hours', 'entrance', 'access', 'info', 'floorlist', 'greet'].includes(intent) && !(room && room.room)) {
        const hits = itemHits(raw, buildings, scopeB, bWords);
        if (hits.length) {
          const where = (h) => `${bname(h.b)} ${h.floor != null ? floorLabel(h.floor) : ''}`.trim();
          const label = hits[0].item;
          const uniqB = [...new Map(hits.map((h) => [h.b.id, h.b])).values()];
          ctx.building = uniqB[0]; ctx.lastIntent = 'route';
          if (uniqB.length === 1) {
            const b1 = uniqB[0];
            const floors = [...new Set(hits.map((h) => h.floor).filter((f) => f != null))];
            const elev = floors.some((f) => f >= 3) && entsOf(b1.id).some((e) => e.props.type === 'elevator');
            const text = floors.length
              ? `${nm(b1)} ${floors.map(floorLabel).join(', ')}에 ${label}${josa(label, '이', '가')} 있어요.${elev ? ' 엘리베이터 출입구로 들어가면 편해요.' : ''}`
              : `${nm(b1)}에 ${label}${josa(label, '이', '가')} 있어요. 몇 층인지는 등록돼 있지 않아요.`;
            const wantsGo = intent === 'route' && /(어디|가는|가려면|길|데려|안내)/.test(raw);
            return { text, actions: [routeAct(b1)], building: b1.id, intent: 'item', auto: wantsGo ? { action: 'route', bid: b1.id, avoidStairs: false } : null };
          }
          const sameItem = hits.every((h) => norm(h.item) === norm(label));
          const allPlaces = [...new Set(hits.map((h) => (sameItem ? where(h) : `${where(h)} ${h.item}`)))];
          const places = allPlaces.length > 6 ? [...allPlaces.slice(0, 6), `외 ${allPlaces.length - 6}곳`] : allPlaces;
          return { text: sameItem ? `${label}${josa(label, '은', '는')} ${places.join(', ')}에 있어요. 가장 가까운 곳으로 안내할 수 있어요.`
            : `찾은 곳이 ${allPlaces.length}군데예요. ${places.join(', ')}. 어디로 갈지 골라 주세요.`,
            actions: uniqB.slice(0, 4).map((x) => ({ label: `${bname(x)} 길찾기`, action: 'route', bid: x.id })), intent: 'item', nearestOf: uniqB.map((x) => x.id) };
        }
      }
      // "도서관 3층에 뭐 있어?", 이어서 "4층은?"
      const floorAsk = room && room.floor != null && !room.room;
      if (floorAsk && (found[0] || ctx.building) && (askFloorList || tokens(raw).length <= 2)) {
        const b2 = found[0]?.b || ctx.building;
        ctx.building = b2; ctx.lastIntent = 'floorlist';
        return { text: floorListText(b2, room.floor), actions: [routeAct(b2)], building: b2.id, intent: 'floorlist' };
      }

      // 건물 없이 편의시설만 물은 경우: 그 시설이 있는 건물 찾기
      if (facility && !found.length) {
        const has = buildings.filter((x) => (x.props.facilities || []).some((f) => norm(f).includes(norm(facility)) || norm(facility).includes(norm(f))));
        if (!has.length) return { text: `${facility} 정보가 등록된 건물이 아직 없어요.`, actions: [], intent: 'facility' };
        ctx.building = has[0];
        return { text: `${facility}${josa(facility, '이', '가')} 있는 건물은 ${has.map(bname).join(', ')}이에요.${has.length > 1 ? ' 가장 가까운 곳으로 안내할까요?' : ''}`,
          actions: has.slice(0, 4).map((x) => ({ label: `${bname(x)} 길찾기`, action: 'route', bid: x.id })), intent: 'facility', nearestOf: has.length > 1 ? has.map((x) => x.id) : null };
      }
      if (!b) {
        const sg = suggest(raw, buildings);
        if (sg.length) return { text: `어느 건물을 말하는지 잘 모르겠어요. 혹시 이 중에 있나요?`, actions: sg.map((x) => ({ label: bname(x), action: 'ask', text: `${bname(x)} 어디야?` })), intent: 'unknown' };
        return { text: '등록된 건물 중에서 찾지 못했어요. 건물 이름이나 줄임말로 다시 물어봐 주세요. "도움말"이라고 하면 예시를 보여 드려요.', actions: [], intent: 'unknown' };
      }
      ctx.building = b;
      // "상허 연구동 309호 어디야?": 수집한 노드가 있으면 건물까지 길찾기 + 그 호실 위치를 지도에 찍음
      const rn = room && room.room && roomNode(b, room.room);
      if (rn) {
        ctx.lastIntent = 'route';
        const where = `${rn.floor != null ? `${floorLabel(rn.floor)} ` : ''}${room.room}`;
        return { text: `${nm(b)} ${where} 위치를 지도에 빨간 점으로 표시할게요. 건물 입구까지 길을 찾고, 들어가서 ${where}${josa(room.room, '으로', '로')} 가면 돼요.`,
          actions: [], building: b.id, intent: 'room', auto: { action: 'route', bid: b.id, node: { ll: [rn.longitude, rn.latitude], label: where, floor: rn.floor, code: rn.building.code } } };
      }
      // "2공은?"처럼 짧게 이어 물으면 바로 앞 질문과 같은 걸 묻는 것으로 봄
      // 이름만 말하면(예: "U7") 길찾기로 보고, "은/는"으로 끝날 때만 앞 질문을 이어받음
      if (!intent && !facility && ctx.lastIntent && tokens(raw).length <= 2 && /(은|는|은요|는요)\s*\??$/.test(raw.trim())) intent = ctx.lastIntent;
      if (!intent && room && room.room) intent = 'floors'; // 노드가 없으면 호실 번호로 층 추정
      if (!intent) intent = facility ? 'facility' : 'route';
      ctx.lastIntent = intent;
      const sure = fuzzyOnly ? `${nm(b)}${josa(bname(b), '을', '를')} 말씀하신 걸로 이해했어요. ` : '';
      if (facility && intent !== 'route') {
        const has = (b.props.facilities || []).some((f) => norm(f).includes(norm(facility)) || norm(facility).includes(norm(f)));
        return { text: sure + (has ? `네, ${nm(b)}에 ${facility}${josa(facility, '이', '가')} 있어요.` : `${nm(b)}에는 ${facility} 정보가 등록돼 있지 않아요.`), actions: [routeAct(b)], building: b.id, intent: 'facility' };
      }
      switch (intent) {
        case 'hours': return { text: sure + hoursText(b), actions: [routeAct(b)], building: b.id, intent };
        case 'floors': return { text: sure + floorsText(b, room), actions: [routeAct(b), ...(entsOf(b.id).some((e) => e.props.type === 'elevator') ? [routeAct(b, true)] : [])], building: b.id, intent };
        case 'entrance': return { text: sure + entranceText(b), actions: [routeAct(b)], building: b.id, intent };
        case 'access': {
          const ok = entsOf(b.id).some((e) => e.props.type !== 'stairs' && e.props.accessible !== false);
          return { text: sure + accessText(b), actions: ok ? [routeAct(b, true)] : [routeAct(b)], building: b.id, intent, auto: ok ? { action: 'route', bid: b.id, avoidStairs: true } : null };
        }
        case 'info': return { text: sure + infoText(b) + floorsHead(b), floors: floorList(b), floorsText: allFloorsText(b), actions: [routeAct(b)], building: b.id, intent };
        case 'floorlist': {
          const fl = floorList(b);
          return { text: sure + (fl.length ? `${nm(b)} 층별 안내예요.` : `${nm(b)}의 층별 안내는 아직 등록돼 있지 않아요.`), floors: fl, floorsText: allFloorsText(b), actions: [routeAct(b)], building: b.id, intent };
        }
        default: return { text: sure + `${nm(b)}${josa(bname(b), '으로', '로')} 가는 길을 찾을게요.`,
          actions: floorList(b).length ? [{ label: '층별 안내 보기', action: 'ask', text: `${bname(b)} 층별 안내` }] : [], building: b.id, intent: 'route', auto: { action: 'route', bid: b.id, avoidStairs: false } };
      }
    }
    return { reply, ctx, directions };
  }

  return { create, directions, findBuildings, tokens, toCho, jamoDist, detectRoom };
})();
if (typeof module !== 'undefined') module.exports = CampusBot;
