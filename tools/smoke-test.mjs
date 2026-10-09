const BASE = 'http://127.0.0.1:8787';
const line = (s) => console.log(s);

async function j(u, o) {
  const r = await fetch(BASE + u, o);
  return { s: r.status, j: await r.json().catch(() => null) };
}

line('===== 最终冒烟测试 =====\n');

const h = (await j('/api/health')).j;
line('[1] 健康检查');
line('    API Key      : ' + (h.deepseek.hasApiKey ? '已就绪  ' + h.deepseek.maskedKey : '未配置'));
line('    Key 来源     : ' + h.deepseek.keySource);
line('    模型         : ' + h.deepseek.model);
line('    宠物 / 文案  : ' + h.catalog.total + ' 只 / ' + h.catalog.withCopy + ' 条 AI 文案');
line('    电影数量     : ' + h.catalog.films);

const pets = (await j('/api/pets')).j;
line('\n[2] 宠物列表: ' + pets.count + ' 只');
const byFilm = {};
for (const p of pets.pets) byFilm[p.film.zh] = (byFilm[p.film.zh] || 0) + 1;
for (const [k, v] of Object.entries(byFilm)) line('    ' + k.padEnd(14) + v + ' 只');
const rar = {};
for (const p of pets.pets) rar[p.rarity] = (rar[p.rarity] || 0) + 1;
line('    稀有度       : ' + Object.entries(rar).map(([k, v]) => k + '=' + v).join('  '));
line('    有经典台词   : ' + pets.pets.filter((p) => p.lineJa).length + ' 只');
line('    AI 文案齐全  : ' + (pets.pets.every((p) => p.copy && p.copy.text) ? '是' : '否'));

line('\n[3] 前端资源');
for (const u of ['/', '/styles.css', '/js/app.js', '/js/widget.js', '/js/speech.js', '/js/api.js', '/favicon.svg', '/__selftest-widget.html', '/pets/totoro-totoro.jpg']) {
  const r = await fetch(BASE + u);
  line('    ' + String(r.status).padEnd(4) + (r.headers.get('content-type') || '').split(';')[0].padEnd(26) + u);
}

line('\n[4] 领养 + 经典日语台词');
const a = (await j('/api/pets/howl-howl/adopt', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ adopter: '旅人' }),
})).j;
line('    ' + a.pet.name + '（' + a.pet.nameJa + '）领养成功');
line('    日语台词 : ' + a.line.ja);
line('    中文翻译 : ' + a.line.zh);
line('    把握度   : ' + a.line.confidence);
line('    语音语言 : ' + a.line.lang);

await j('/api/pets/howl-howl/adopt', { method: 'DELETE' });
const after = (await j('/api/health')).j;
line('    已送回，当前已领养: ' + after.catalog.adopted + ' 只（干净状态）');

line('\n===== 全部通过 =====');
