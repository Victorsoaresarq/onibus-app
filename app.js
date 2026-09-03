// ==================== CONFIGURAÇÃO V3 ====================
const CONFIG={
 API_URL:'https://dados.mobilidade.rio/gps/sppo',
 // Tenta direto primeiro. O proxy público é só um fallback de emergência —
 // ele não tem SLA e pode cair a qualquer momento. Se você tiver um backend
 // próprio (mesmo uma function serverless simples), troque essa entrada por ele.
 PROXIES:[u=>u,u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`],
 INTERVALO_ATUALIZACAO:15000,
 TIMEOUT_REQUISICAO:9000,
 DADO_STALE_MS:120000,
 CORES_DEFAULT:['#1b6354','#e65100','#1565c0','#7b1fa2','#c62828','#0284c7'],
 MAX_BACKOFF_MS:120000,
 // Quantos pontos de GPS guardar por linha para desenhar o "itinerário real"
 // (rastro observado). Isso NÃO é o trajeto oficial da linha (que exigiria
 // baixar e cruzar o GTFS completo) — é o caminho que os ônibus realmente
 // percorreram, construído a partir do próprio feed de GPS que já consumimos.
 MAX_PONTOS_ITINERARIO:600,
 STORAGE_KEY_FAVORITOS:'cadeoonibus.favoritos.v1'
};

const linhasAtivas={};
let corIndex=0,userMarker=null,intervaloAtualizacao=null,atualizacaoEmAndamento=false;
let veiculoSelecionado=null; // {linha, id}

const map=L.map('map',{zoomControl:false,preferCanvas:true}).setView([-22.9068,-43.1729],12);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(map);
L.control.zoom({position:'bottomright'}).addTo(map);
const legendaGlobal=L.control({position:'bottomleft'});
legendaGlobal.onAdd=()=>{const d=L.DomUtil.create('div','map-legend');d.id='mapLegend';L.DomEvent.disableClickPropagation(d);return d};
legendaGlobal.addTo(map);

// ==================== UTILITÁRIOS ====================
function esc(v){return String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;')}
function norm(v){return String(v??'').trim()}
function key(v){return norm(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'')}
function num(v){if(v===null||v===undefined||v==='')return false;return Number.isFinite(Number(String(v).replace(',','.')))}
function coord(lat,lng){return num(lat)&&num(lng)&&Math.abs(Number(lat))<=90&&Math.abs(Number(lng))<=180&&!(Number(lat)===0&&Number(lng)===0)}
function campo(o,nomes){if(!o||typeof o!=='object')return;const ks=Object.keys(o);for(const n of nomes){if(o[n]!==undefined&&o[n]!==null&&o[n]!=='')return o[n];const alvo=key(n),k=ks.find(x=>key(x)===alvo);if(k!==undefined&&o[k]!==undefined&&o[k]!==null&&o[k]!=='')return o[k]}}
function timestamp(bus){for(const v of [bus.datetime,bus.timestamp,bus.datahora,bus.data_hora,bus.dt_gps,bus.hora,bus.last_update,bus.updated_at]){if(v===null||v===undefined||v==='')continue;if(typeof v==='number'||/^\d+$/.test(String(v).trim())){let n=Number(v);if(n<100000000000)n*=1000;const d=new Date(n);if(!Number.isNaN(d.getTime()))return d}const d=new Date(v);if(!Number.isNaN(d.getTime()))return d}return null}
function idade(bus){const d=timestamp(bus);return d?Math.max(0,Date.now()-d.getTime()):null}
function stale(bus){const i=idade(bus);return i!==null&&i>CONFIG.DADO_STALE_MS}
function idadeTexto(ms){if(ms===null)return'idade do GPS não informada';const s=Math.floor(ms/1000);if(s<60)return`há ${s}s`;const m=Math.floor(s/60);if(m<60)return`há ${m} min`;const h=Math.floor(m/60);return`há ${h}h ${m%60}min`}
function dataTexto(d){return d?d.toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'não informado'}
function vel(v){return num(v)?`${Math.max(0,Number(v)).toFixed(0)} km/h`:'N/D'}

// ==================== FAVORITOS (persistência local) ====================
function carregarFavoritos(){try{const raw=localStorage.getItem(CONFIG.STORAGE_KEY_FAVORITOS);const arr=JSON.parse(raw);return Array.isArray(arr)?arr.filter(x=>typeof x==='string'):[]}catch{return[]}}
function salvarFavoritos(lista){try{localStorage.setItem(CONFIG.STORAGE_KEY_FAVORITOS,JSON.stringify(lista))}catch{/* localStorage indisponível (modo privado, cota etc.) — favoritos seguem só na sessão */}}
function isFavorito(linha){return carregarFavoritos().includes(linha)}
function alternarFavorito(linha){const atuais=carregarFavoritos();const idx=atuais.indexOf(linha);if(idx>=0)atuais.splice(idx,1);else atuais.push(linha);salvarFavoritos(atuais);renderChips();renderFavoritos()}

// ==================== NORMALIZAÇÃO ====================
function colunar(data){if(!data||!Array.isArray(data.DATA))return null;const cols=Array.isArray(data.COLUMNS)?data.COLUMNS:Array.isArray(data.columns)?data.columns:[];if(!cols.length)return null;return data.DATA.map(row=>{const o={};cols.forEach((c,i)=>o[c]=Array.isArray(row)?row[i]:undefined);return o})}
function lista(data){if(Array.isArray(data))return data;const c=colunar(data);if(c)return c;for(const x of [data?.DATA,data?.data,data?.vehicles,data?.veiculos,data?.results,data?.results?.vehicles,data?.features])if(Array.isArray(x))return x;return[]}
function normalizar(raw,linha){if(!raw||typeof raw!=='object')return null;const p=raw.properties&&typeof raw.properties==='object'?{...raw.properties,...raw}:raw;let lat=campo(p,['latitude','lat','y']),lng=campo(p,['longitude','lon','lng','long','x']);if((!num(lat)||!num(lng))&&raw.geometry?.coordinates?.length){lng=raw.geometry.coordinates[0];lat=raw.geometry.coordinates[1]}if(!coord(lat,lng))return null;return{...p,linha:norm(campo(p,['linha','line','route','route_id','servico','service']))||linha,ordem:norm(campo(p,['ordem','id_veiculo','idVeiculo','veiculo','vehicle_id','vehicleId','carro','id']))||'N/D',latitude:Number(lat),longitude:Number(lng),velocidade:num(campo(p,['velocidade','speed','vel']))?Number(campo(p,['velocidade','speed','vel'])):null,direcao:norm(campo(p,['direcao','direção','direction','sentido','trip_headsign']))||'N/D',datetime:campo(p,['datetime','timestamp','datahora','data_hora','dt_gps','hora','last_update','updated_at'])??null,trip_id:norm(campo(p,['trip_id','tripId'])),route_id:norm(campo(p,['route_id','routeId']))}}
// daLinha: se a API não trouxer nenhum campo identificável de linha/rota no
// payload, aceitamos o veículo (fallback), já que a própria query foi feita
// filtrando por ?linha=. Isso é intencional, mas fique de olho: se a SMTR
// mudar o formato da resposta e passar a nomear a linha de outro jeito, os
// nomes abaixo precisam ser atualizados ou veículos de outras linhas podem
// "vazar" para o filtro errado.
function daLinha(bus,linha){const alvo=norm(linha).toUpperCase();const vals=[bus.linha,bus.route_id,bus.servico,bus.service].filter(Boolean).map(v=>norm(v).toUpperCase());if(!vals.length)return true;return vals.some(v=>v===alvo||v.replace(/^0+/,'')===alvo.replace(/^0+/,''))}
function normalizarResposta(data,linha){return lista(data).map(x=>normalizar(x,linha)).filter(Boolean).filter(x=>daLinha(x,linha))}

// ==================== REDE ====================
async function fetchTimeout(url){const c=new AbortController(),t=setTimeout(()=>c.abort(),CONFIG.TIMEOUT_REQUISICAO);try{const r=await fetch(url,{cache:'no-store',signal:c.signal,headers:{Accept:'application/json,text/plain,*/*'}});if(!r.ok)throw Error(`HTTP ${r.status}`);const txt=await r.text();if(!txt.trim())throw Error('Resposta vazia');try{return JSON.parse(txt)}catch{throw Error('Resposta não é JSON válido')}}finally{clearTimeout(t)}}
async function buscarDadosLinha(linha){const target=`${CONFIG.API_URL}?linha=${encodeURIComponent(linha)}`;let erro=null;for(const mk of CONFIG.PROXIES){try{const data=await fetchTimeout(mk(target));return{ok:true,veiculos:normalizarResposta(data,linha),fonte:mk===CONFIG.PROXIES[0]?'SMTR direto':'proxy',erro:null}}catch(e){erro=e;console.warn(`[Cadê o Ônibus] Falha ao buscar linha ${linha} via ${mk===CONFIG.PROXIES[0]?'direto':'proxy'}:`,e.message)}}return{ok:false,veiculos:[],fonte:null,erro:erro||Error('Falha de rede')}}

// ==================== LINHAS / UI ====================
function atalhoLinha(l){document.getElementById('linhaInput').value=l;adicionarLinha()}

function criarInfoLinha(cor){
 return{
  color:cor,
  layerGroup:L.layerGroup().addTo(map),
  routeLayer:null,           // polyline do itinerário (rastro real observado)
  routeVisible:true,
  routePoints:[],            // [[lat,lng], ...] em ordem de chegada, deduplicado
  ultimosDados:[],
  markers:new Map(),         // id veículo -> marker
  circles:new Map(),         // id veículo -> circle
  markerState:new Map(),     // id veículo -> {stale, selecionado} (evita recriar ícone à toa)
  lastSuccess:null,
  lastAttempt:null,
  error:null,
  fonte:null,
  carregando:false,
  primeiraCarga:true,
  falhasConsecutivas:0
 };
}

async function adicionarLinha(linhaForcada){
 const input=document.getElementById('linhaInput');
 const linha=norm(linhaForcada??input.value).toUpperCase();
 if(!linha){mostrarStatus('⚠️ Digite o número da linha.');input.focus();return}
 if(linhasAtivas[linha]){mostrarStatus(`⚠️ Linha ${linha} já está sendo monitorada.`);input.value='';return}
 const cor=CONFIG.CORES_DEFAULT[corIndex++%CONFIG.CORES_DEFAULT.length];
 linhasAtivas[linha]=criarInfoLinha(cor);
 input.value='';
 renderChips();renderFavoritos();atualizarLegenda();atualizarStatusGeral();
 await buscarEDesenharLinha(linha,true);
}

function removerLinha(l){
 const i=linhasAtivas[l];if(!i)return;
 map.removeLayer(i.layerGroup);
 if(i.routeLayer)map.removeLayer(i.routeLayer);
 if(veiculoSelecionado&&veiculoSelecionado.linha===l)limparSelecao();
 delete linhasAtivas[l];
 renderChips();renderFavoritos();atualizarLegenda();atualizarStatusGeral();
}

function mudarCorLinha(l,c){
 const i=linhasAtivas[l];if(!i)return;
 i.color=c;
 i.markers.forEach((m,id)=>{const st=i.markerState.get(id)||{};m.setIcon(icone(l,c,!!st.stale,!!st.selecionado))});
 i.circles.forEach(x=>x.setStyle({color:c,fillColor:c}));
 if(i.routeLayer)i.routeLayer.setStyle({color:c});
 renderChips();atualizarLegenda();
}

function alternarRota(l){
 const i=linhasAtivas[l];if(!i)return;
 i.routeVisible=!i.routeVisible;
 if(i.routeLayer){
  if(i.routeVisible)i.routeLayer.addTo(map);else map.removeLayer(i.routeLayer);
 }
 renderChips();
}

function renderChips(){
 const c=document.getElementById('chipsContainer');
 c.innerHTML='';
 Object.keys(linhasAtivas).forEach(l=>{
  const i=linhasAtivas[l],fav=isFavorito(l);
  const chip=document.createElement('div');
  chip.className='line-chip'+(fav?' is-fav':'');

  const color=document.createElement('input');
  color.type='color';color.className='color-picker-input';color.value=i.color;color.title='Mudar cor';
  color.onchange=e=>mudarCorLinha(l,e.target.value);

  const s=document.createElement('span');s.textContent=`Linha ${l}`;

  const routeBtn=document.createElement('button');
  routeBtn.className='chip-route'+(i.routeVisible?' active':'');
  routeBtn.type='button';routeBtn.title='Mostrar/ocultar itinerário percorrido';
  routeBtn.textContent='〰️';
  routeBtn.onclick=()=>alternarRota(l);

  const favBtn=document.createElement('button');
  favBtn.className='chip-fav'+(fav?' active':'');
  favBtn.type='button';favBtn.title=fav?'Remover dos fixados':'Fixar linha (uso diário)';
  favBtn.textContent=fav?'★':'☆';
  favBtn.onclick=()=>alternarFavorito(l);

  const b=document.createElement('button');
  b.className='chip-remove';b.type='button';b.textContent='×';b.title=`Remover linha ${l}`;
  b.onclick=()=>removerLinha(l);

  chip.append(color,s,routeBtn,favBtn,b);
  c.appendChild(chip);
 });
}

function renderFavoritos(){
 const section=document.getElementById('favSection');
 const cont=document.getElementById('favChipsContainer');
 const favs=carregarFavoritos().filter(l=>!linhasAtivas[l]); // só mostra as que ainda não estão no mapa
 if(!favs.length){section.style.display='none';cont.innerHTML='';return}
 section.style.display='block';
 cont.innerHTML='';
 favs.forEach(l=>{
  const chip=document.createElement('button');
  chip.type='button';chip.className='fav-chip';
  chip.textContent=`⭐ ${l}`;
  chip.title=`Adicionar linha ${l} ao monitoramento`;
  chip.onclick=()=>adicionarLinha(l);
  cont.appendChild(chip);
 });
}

function mostrarStatus(t){document.getElementById('status-msg').textContent=t}

// ==================== MAPA / VEÍCULOS ====================
function icone(linha,cor,isStale,isSelecionado){
 const classes=['bus-marker-pin'];
 if(isStale)classes.push('stale');
 if(isSelecionado)classes.push('selected');
 return L.divIcon({
  className:'custom-bus-pin',
  html:`<div class="${classes.join(' ')}" style="background:${esc(cor)};">🚌 ${esc(linha)}</div>`,
  iconSize:[64,22],iconAnchor:[32,11],popupAnchor:[0,-10]
 });
}

function idVeiculo(b){return norm(b.ordem||b.id_veiculo||b.vehicle_id||b.trip_id||`${b.latitude}:${b.longitude}`)}

function popup(marker,b,cor,linha){
 const d=timestamp(b),i=idade(b),s=stale(b);
 const id=idVeiculo(b);
 marker.bindPopup(
  `<div class="popup">`+
  `<div class="popup-title" style="color:${esc(cor)};">Linha ${esc(b.linha)}</div>`+
  `<div><b>Carro:</b> ${esc(b.ordem||'N/D')}</div>`+
  `<div><b>Velocidade:</b> ${esc(vel(b.velocidade))}</div>`+
  `<div><b>Sentido:</b> ${esc(b.direcao||'N/D')}</div>`+
  `<div class="popup-muted">GPS: ${esc(dataTexto(d))}<br>${esc(idadeTexto(i))}${s?'<br><span class="legend-stale">⚠️ Dado possivelmente desatualizado</span>':''}</div>`+
  `<button class="popup-select-btn" onclick="selecionarVeiculo('${esc(linha)}','${esc(id)}')">🔎 Acompanhar este carro</button>`+
  `</div>`
 );
}

// Acrescenta pontos novos ao rastro (itinerário real observado) da linha,
// evitando pontos repetidos/quase idênticos para não inchar a polyline.
function acumularRota(info,veiculos){
 for(const b of veiculos){
  const p=[b.latitude,b.longitude];
  const ultimo=info.routePoints[info.routePoints.length-1];
  if(ultimo){
   const dLat=Math.abs(ultimo[0]-p[0]),dLng=Math.abs(ultimo[1]-p[1]);
   if(dLat<0.00006&&dLng<0.00006)continue; // ~7m, ignora ruído de GPS parado
  }
  info.routePoints.push(p);
 }
 if(info.routePoints.length>CONFIG.MAX_PONTOS_ITINERARIO){
  info.routePoints=info.routePoints.slice(-CONFIG.MAX_PONTOS_ITINERARIO);
 }
}

function desenharRota(info,linha){
 if(!info.routePoints.length)return;
 if(!info.routeLayer){
  info.routeLayer=L.polyline(info.routePoints,{
   color:info.color,weight:3,opacity:.55,dashArray:'1,7',lineCap:'round'
  });
  if(info.routeVisible)info.routeLayer.addTo(map);
 }else{
  info.routeLayer.setLatLngs(info.routePoints);
 }
}

function selecionarVeiculo(linha,id){
 veiculoSelecionado={linha,id};
 atualizarSelecaoVisual();
 atualizarPainelSelecionado();
}

function limparSelecao(){
 veiculoSelecionado=null;
 atualizarSelecaoVisual();
 document.getElementById('selectedPanel').classList.remove('visible');
}

function atualizarSelecaoVisual(){
 Object.entries(linhasAtivas).forEach(([l,info])=>{
  info.markers.forEach((m,id)=>{
   const isSel=!!veiculoSelecionado&&veiculoSelecionado.linha===l&&veiculoSelecionado.id===id;
   const st=info.markerState.get(id)||{};
   if(st.selecionado===isSel)return; // nada mudou, não recria ícone
   st.selecionado=isSel;
   info.markerState.set(id,st);
   m.setIcon(icone(l,info.color,!!st.stale,isSel));
   if(isSel)m.setZIndexOffset(2000);else m.setZIndexOffset(1000);
  });
 });
}

function atualizarPainelSelecionado(){
 const painel=document.getElementById('selectedPanel');
 if(!veiculoSelecionado){painel.classList.remove('visible');return}
 const info=linhasAtivas[veiculoSelecionado.linha];
 if(!info){limparSelecao();return}
 const bus=info.ultimosDados.find(b=>idVeiculo(b)===veiculoSelecionado.id);
 if(!bus){
  // O carro pode ter saído da linha/temporariamente sem sinal. Mantém o
  // painel com aviso em vez de sumir de repente.
  document.getElementById('selectedPanelTitle').textContent=`Linha ${esc(veiculoSelecionado.linha)} · carro ${esc(veiculoSelecionado.id)}`;
  document.getElementById('selectedPanelBody').innerHTML=`<div style="grid-column:1/-1;color:var(--warning)">⚠️ Este carro não aparece na última atualização.</div>`;
  painel.classList.add('visible');
  return;
 }
 const d=timestamp(bus),i=idade(bus);
 document.getElementById('selectedPanelTitle').textContent=`Linha ${esc(bus.linha)} · carro ${esc(bus.ordem)}`;
 document.getElementById('selectedPanelBody').innerHTML=
  `<div><b>Velocidade:</b> ${esc(vel(bus.velocidade))}</div>`+
  `<div><b>Sentido:</b> ${esc(bus.direcao)}</div>`+
  `<div><b>GPS:</b> ${esc(idadeTexto(i))}</div>`+
  `<div><b>Atualizado:</b> ${esc(dataTexto(d))}</div>`;
 painel.classList.add('visible');
}

function atualizarVeiculos(info,linha,veiculos){
 const ativos=new Set();
 for(const b of veiculos){
  const id=idVeiculo(b);
  ativos.add(id);
  const pos=[b.latitude,b.longitude];
  const s=stale(b);
  const isSel=!!veiculoSelecionado&&veiculoSelecionado.linha===linha&&veiculoSelecionado.id===id;
  let m=info.markers.get(id),c=info.circles.get(id);
  const stAnterior=info.markerState.get(id);
  const mudouEstado=!stAnterior||stAnterior.stale!==s||stAnterior.selecionado!==isSel;

  if(!m){
   m=L.marker(pos,{icon:icone(linha,info.color,s,isSel),zIndexOffset:isSel?2000:1000}).addTo(info.layerGroup);
   info.markers.set(id,m);
  }else{
   m.setLatLng(pos);
   if(mudouEstado)m.setIcon(icone(linha,info.color,s,isSel)); // só recria o ícone se algo visual mudou
  }
  info.markerState.set(id,{stale:s,selecionado:isSel});

  if(!c){
   c=L.circle(pos,{radius:25,color:info.color,fillColor:info.color,fillOpacity:.15,weight:1.5}).addTo(info.layerGroup);
   info.circles.set(id,c);
  }else{
   c.setLatLng(pos);
   c.setStyle({color:info.color,fillColor:info.color});
  }
  popup(m,b,info.color,linha);
 }
 for(const[id,m]of info.markers)if(!ativos.has(id)){info.layerGroup.removeLayer(m);info.markers.delete(id);info.markerState.delete(id)}
 for(const[id,c]of info.circles)if(!ativos.has(id)){info.layerGroup.removeLayer(c);info.circles.delete(id)}

 acumularRota(info,veiculos);
 desenharRota(info,linha);

 if(veiculoSelecionado&&veiculoSelecionado.linha===linha)atualizarPainelSelecionado();
}

// ==================== BUSCA / DESENHO ====================
async function buscarEDesenharLinha(linha,fit=false){
 const info=linhasAtivas[linha];
 if(!info||info.carregando)return;
 info.carregando=true;info.lastAttempt=Date.now();
 try{
  const r=await buscarDadosLinha(linha);
  if(!linhasAtivas[linha])return; // linha removida durante o fetch
  if(!r.ok){
   info.error=r.erro;
   info.falhasConsecutivas++;
   atualizarLegenda();atualizarStatusGeral();
   return;
  }
  info.error=null;
  info.falhasConsecutivas=0;
  info.fonte=r.fonte;
  info.ultimosDados=r.veiculos;
  info.lastSuccess=Date.now();
  info.primeiraCarga=false;
  atualizarVeiculos(info,linha,r.veiculos);
  if(fit&&r.veiculos.length){
   const pts=r.veiculos.map(b=>[b.latitude,b.longitude]);
   if(pts.length===1)map.setView(pts[0],Math.min(map.getZoom(),15));
   else map.fitBounds(pts,{padding:[80,80],maxZoom:14});
  }
  atualizarLegenda();atualizarStatusGeral();
 }catch(e){
  info.error=e;
  info.falhasConsecutivas++;
  atualizarLegenda();atualizarStatusGeral();
 }finally{
  if(linhasAtivas[linha])linhasAtivas[linha].carregando=false;
 }
}

function atualizarLegenda(){
 const d=document.getElementById('mapLegend');
 const entries=Object.entries(linhasAtivas);
 if(!entries.length){d.innerHTML='';d.style.display='none';return}
 d.style.display='block';
 d.innerHTML=entries.map(([l,i])=>{
  const erro=!!i.error;
  const ult=i.lastSuccess?`atualizado ${idadeTexto(Date.now()-i.lastSuccess)}`:'aguardando dados';
  return `<div class="legend-row"><span class="legend-dot" style="background:${esc(i.color)}"></span>`+
   `<span><b style="color:${esc(i.color)}">Linha ${esc(l)}</b> · ${i.ultimosDados.length} ônibus · ${esc(ult)}`+
   `${erro?'<span class="legend-error"> · sem atualização</span>':''}</span></div>`;
 }).join('');
}

function atualizarStatusGeral(){
 const a=Object.values(linhasAtivas),n=a.length;
 if(!n){mostrarStatus('➕ Adicione uma linha acima para iniciar o monitoramento.');return}
 const total=a.reduce((x,i)=>x+i.ultimosDados.length,0),erros=a.filter(i=>i.error).length;
 if(erros===n&&a.every(i=>i.primeiraCarga)){mostrarStatus('⚠️ Não foi possível obter os dados agora. Tentando novamente...');return}
 let t=`🚌 ${n} linha(s) | ${total} ônibus monitorados`;
 t+=erros?` | ⚠️ ${erros} sem atualização`:` | atualização a cada ${CONFIG.INTERVALO_ATUALIZACAO/1000}s`;
 mostrarStatus(t);
}

// ==================== ATUALIZAÇÃO (com backoff por linha) ====================
function deveAtualizarAgora(info){
 // Backoff exponencial só quando a linha está falhando repetidamente, para
 // não martelar a API (e os proxies) indefinidamente em caso de instabilidade.
 if(info.falhasConsecutivas===0)return true;
 const atraso=Math.min(CONFIG.MAX_BACKOFF_MS,CONFIG.INTERVALO_ATUALIZACAO*Math.pow(2,info.falhasConsecutivas));
 return Date.now()-(info.lastAttempt||0)>=atraso;
}

async function atualizarTodasLinhas(){
 const ls=Object.keys(linhasAtivas).filter(l=>deveAtualizarAgora(linhasAtivas[l]));
 if(!ls.length||atualizacaoEmAndamento)return;
 atualizacaoEmAndamento=true;
 try{
  await Promise.allSettled(ls.map(l=>buscarEDesenharLinha(l,false)));
 }finally{
  atualizacaoEmAndamento=false;
 }
}

function iniciarAtualizacao(){
 if(intervaloAtualizacao)clearInterval(intervaloAtualizacao);
 intervaloAtualizacao=setInterval(atualizarTodasLinhas,CONFIG.INTERVALO_ATUALIZACAO);
}

// ==================== LOCALIZAÇÃO ====================
function localizarUsuario(){
 const b=document.getElementById('btnGeo');
 if(!navigator.geolocation){alert('📍 Geolocalização não disponível neste dispositivo.');return}
 b.disabled=true;b.textContent='⏳ Buscando...';
 navigator.geolocation.getCurrentPosition(p=>{
  const{latitude:lat,longitude:lng,accuracy}=p.coords;
  if(userMarker)map.removeLayer(userMarker);
  userMarker=L.circleMarker([lat,lng],{radius:10,fillColor:'#007aff',color:'#fff',weight:3,opacity:1,fillOpacity:1}).addTo(map);
  userMarker.bindPopup(`📍 <b>Você está aqui</b><br><span style="font-size:11px;color:#6b7280">Precisão aproximada: ${Math.round(accuracy)} m</span>`).openPopup();
  map.setView([lat,lng],15);
  b.disabled=false;b.textContent='📍 Onde estou';
 },e=>{
  b.disabled=false;b.textContent='📍 Onde estou';
  let m='Não foi possível obter sua localização.';
  if(e.code===1)m+=' Permita o acesso à localização nas configurações.';
  else if(e.code===2)m+=' O sinal de localização está indisponível.';
  else if(e.code===3)m+=' A tentativa demorou demais.';
  alert('📍 '+m);
 },{enableHighAccuracy:true,timeout:10000,maximumAge:30000});
}

// ==================== INICIALIZAÇÃO ====================
document.getElementById('linhaInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();adicionarLinha()}});
renderFavoritos();
iniciarAtualizacao();
atualizarLegenda();
atualizarStatusGeral();
console.log('🚌 Cadê o Ônibus? V3 — GPS público SMTR, itinerário = rastro real observado, favoritos locais, sem simulação.');
