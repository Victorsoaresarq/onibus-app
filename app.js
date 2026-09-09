/**
 * Cadê o Ônibus? • Mobilidade Carioca
 * Webapp de monitoramento de ônibus em tempo real para o Rio de Janeiro
 * Estilo visual inspirado no Apple Maps (OpenStreetMap via CartoDB Voyager)
 */

// ==================== CONFIGURAÇÃO ====================
const CONFIG = {
  API_URL: 'https://dados.mobilidade.rio/gps/sppo',
  INTERVALO_ATUALIZACAO: 15000, // 15 segundos
  TIMEOUT_REQUISICAO: 10000,    // 10 segundos
  CORES_DEFAULT: ['#1b6354', '#e65100', '#1565c0', '#7b1fa2', '#c62828', '#0284c7', '#2e7d32'],
  STORAGE_KEY_FAVORITOS: 'cadeoonibus_favoritos_v1'
};

// ==================== ESTADO GLOBAL ====================
const linhasAtivas = {}; // { [linha]: { cor, markers, layerGroup, veiculos, modoDemo } }
let corIndex = 0;
let veiculoSelecionado = null; // { linha, id }
let userMarker = null;
let userAccuracyCircle = null;
let intervaloAtualizacao = null;

// ==================== INICIALIZAÇÃO DO MAPA (ESTILO APPLE MAPS) ====================
// Centro inicial: Centro do Rio de Janeiro
const map = L.map('map', {
  zoomControl: false,
  preferCanvas: true
}).setView([-22.9068, -43.1729], 13);

// Camada CartoDB Voyager (OpenStreetMap com visual limpo, tons pastéis e fontes estilo Apple Maps)
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank">CARTO</a>',
  subdomains: 'abcd',
  maxZoom: 19
}).addTo(map);

// Controle de Zoom na parte inferior direita
L.control.zoom({ position: 'bottomright' }).addTo(map);

// Força o Leaflet a recalcular as dimensões exatas da janela para não deixar tiles em branco
setTimeout(() => map.invalidateSize(), 150);
setTimeout(() => map.invalidateSize(), 600);
window.addEventListener('resize', () => map.invalidateSize());

// Legenda no canto inferior esquerdo
const legendaGlobal = L.control({ position: 'bottomleft' });
legendaGlobal.onAdd = () => {
  const div = L.DomUtil.create('div', 'map-legend');
  div.id = 'mapLegend';
  div.style.display = 'none';
  L.DomEvent.disableClickPropagation(div);
  return div;
};
legendaGlobal.addTo(map);

// ==================== UTILITÁRIOS ====================
function normalizarNumeroLinha(linha) {
  return String(linha || '').trim().toUpperCase().replace(/^0+/, '');
}

function sanitizarTexto(str) {
  return String(str || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatarDataHora(data) {
  if (!data) return 'Não informado';
  return data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatarVelocidade(vel) {
  const v = Number(vel);
  return Number.isFinite(v) && v > 0 ? `${Math.round(v)} km/h` : 'Parado / N/D';
}

function calcularIdadeMinutos(timestamp) {
  if (!timestamp) return null;
  const ms = Date.now() - timestamp;
  const segs = Math.floor(ms / 1000);
  if (segs < 60) return `há ${segs}s`;
  const mins = Math.floor(segs / 60);
  return `há ${mins} min`;
}

// ==================== PERSISTÊNCIA DE FAVORITOS ====================
function carregarFavoritos() {
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE_KEY_FAVORITOS);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function salvarFavoritos(lista) {
  try {
    localStorage.setItem(CONFIG.STORAGE_KEY_FAVORITOS, JSON.stringify(lista));
  } catch {
    // Ignora restrições de localStorage em modo anônimo
  }
}

function alternarFavorito(linha) {
  const norm = normalizarNumeroLinha(linha);
  let favs = carregarFavoritos();
  if (favs.includes(norm)) {
    favs = favs.filter(l => l !== norm);
  } else {
    favs.push(norm);
  }
  salvarFavoritos(favs);
  renderChips();
  renderFavoritos();
}

// ==================== REDE E API DA SMTR COM FALLBACK ====================
/**
 * Monta os parâmetros de dataInicial e dataFinal exigidos pela API do SPPO
 * com uma janela dos últimos 3 minutos no horário de Brasília
 */
function getJanelaTempo() {
  const agora = new Date();
  const tresMinutosAtras = new Date(agora.getTime() - 3 * 60 * 1000);

  const formatar = (d) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}+${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  return {
    inicio: formatar(tresMinutosAtras),
    fim: formatar(agora)
  };
}

async function fetchComTimeout(url, timeoutMs = CONFIG.TIMEOUT_REQUISICAO) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Consulta a API de GPS da SMTR através de proxies CORS ou direto
 */
async function buscarOnibusDaLinhaNaAPI(linhaAlvo) {
  const { inicio, fim } = getJanelaTempo();
  const alvoNorm = normalizarNumeroLinha(linhaAlvo);

  // A API oficial espera dataInicial e dataFinal no formato AAAA-MM-DD+HH:MM:SS
  const endpointAlvo = `${CONFIG.API_URL}?dataInicial=${inicio}&dataFinal=${fim}`;

  // Estratégia de requisição: proxy CORS confiável -> fallback alternativo -> direto
  const urlsTentativas = [
    `https://corsproxy.io/?${encodeURIComponent(endpointAlvo)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(endpointAlvo)}`,
    endpointAlvo
  ];

  for (const url of urlsTentativas) {
    try {
      const data = await fetchComTimeout(url);
      let lista = [];

      // Suporta formato direto em array ou formato colunar legado { COLUMNS, DATA }
      if (Array.isArray(data)) {
        lista = data;
      } else if (data && Array.isArray(data.DATA) && Array.isArray(data.COLUMNS)) {
        lista = data.DATA.map(row => {
          const item = {};
          data.COLUMNS.forEach((col, idx) => { item[col.toLowerCase()] = row[idx]; });
          return item;
        });
      }

      if (Array.isArray(lista) && lista.length > 0) {
        // Filtra os ônibus da linha solicitada
        const onibusEncontrados = lista.filter(item => {
          const l = normalizarNumeroLinha(item.linha || item.servico || item.line || item.route_id);
          return l === alvoNorm || l.includes(alvoNorm);
        }).map(item => ({
          ordem: String(item.ordem || item.id_veiculo || item.veiculo || 'N/D'),
          linha: String(item.linha || linhaAlvo),
          latitude: Number(item.latitude || item.lat),
          longitude: Number(item.longitude || item.lon || item.lng),
          velocidade: Number(item.velocidade || item.speed || 0),
          direcao: String(item.direcao || item.sentido || 'Ida / Volta'),
          timestamp: item.datahora ? (typeof item.datahora === 'number' ? (item.datahora < 1e11 ? item.datahora * 1000 : item.datahora) : new Date(item.datahora).getTime()) : Date.now()
        })).filter(b => !isNaN(b.latitude) && !isNaN(b.longitude) && b.latitude !== 0);

        return { sucesso: true, veiculos: onibusEncontrados, fonte: 'SMTR GPS Oficial' };
      }
    } catch (err) {
      console.warn(`[Cadê o Ônibus] Tentativa de buscar linha ${linhaAlvo} falhou:`, err.message);
    }
  }

  return { sucesso: false, veiculos: [], fonte: null };
}

// ==================== MODO DEMONSTRAÇÃO (FALLBACK REALISTA) ====================
// Caso o servidor da prefeitura ou o proxy público estejam fora do ar (muito comum no Rio),
// simulamos veículos ao longo dos corredores reais da cidade para garantir que o app
// sempre apresente dados funcionais para o usuário avaliar a interface.
const CORREDORES_DEMO = {
  '232': [ // Lins <-> Castelo (Méier, Grajaú, Tijuca, Centro)
    [-22.9056, -43.1763], [-22.9130, -43.1890], [-22.9242, -43.2320], [-22.9125, -43.2680]
  ],
  '606': [ // Engenho de Dentro <-> Rodoviária (Vila Isabel, Tijuca)
    [-22.9015, -43.2085], [-22.9230, -43.2420], [-22.9001, -43.2840]
  ],
  '693': [ // Méier <-> Alvorada (Linha Amarela, Barra)
    [-22.9018, -43.2815], [-22.9420, -43.3420], [-22.9995, -43.3650]
  ],
  '2345': [ // Santa Cruz <-> Castelo (Avenida Brasil)
    [-22.9040, -43.1800], [-22.8850, -43.2400], [-22.8400, -43.3400]
  ]
};

function gerarVeiculosDemo(linha) {
  const norm = normalizarNumeroLinha(linha);
  const trajeto = CORREDORES_DEMO[norm] || [
    [-22.9068, -43.1729],
    [-22.9130, -43.2100],
    [-22.9200, -43.2350]
  ];

  const agora = Date.now();
  const offset = (agora / 10000) % 1; // Movimento contínuo suave

  return trajeto.slice(0, 3).map((ponto, i) => {
    const lat = ponto[0] + (Math.sin(offset * 6.28 + i) * 0.005);
    const lng = ponto[1] + (Math.cos(offset * 6.28 + i) * 0.005);
    return {
      ordem: `A${norm}0${i + 1}`,
      linha: linha,
      latitude: lat,
      longitude: lng,
      velocidade: 25 + Math.round(Math.random() * 20),
      direcao: i % 2 === 0 ? 'Centro' : 'Bairro',
      timestamp: agora - (i * 30000)
    };
  });
}

// ==================== CONTROLE DE LINHAS E INTERFACE ====================
function atalhoLinha(linha) {
  document.getElementById('linhaInput').value = linha;
  adicionarLinha(linha);
}

function criarPinIcone(linha, cor, isSelecionado) {
  const classes = ['bus-marker-pin'];
  if (isSelecionado) classes.push('selected');

  return L.divIcon({
    className: 'custom-bus-pin',
    html: `<div class="${classes.join(' ')}" style="background:${cor}; border-color:#fff;">🚌 ${sanitizarTexto(linha)}</div>`,
    iconSize: [64, 24],
    iconAnchor: [32, 12],
    popupAnchor: [0, -12]
  });
}

async function adicionarLinha(linhaParam) {
  const input = document.getElementById('linhaInput');
  const linhaBruta = typeof linhaParam === 'string' ? linhaParam : input.value;
  const linha = normalizarNumeroLinha(linhaBruta);

  if (!linha) {
    mostrarStatus('⚠️ Digite o número de uma linha de ônibus.');
    input.focus();
    return;
  }

  if (linhasAtivas[linha]) {
    mostrarStatus(`⚠️ A Linha ${linha} já está no mapa.`);
    input.value = '';
    return;
  }

  const cor = CONFIG.CORES_DEFAULT[corIndex % CONFIG.CORES_DEFAULT.length];
  corIndex++;

  linhasAtivas[linha] = {
    cor,
    layerGroup: L.layerGroup().addTo(map),
    markers: new Map(),
    veiculos: [],
    modoDemo: false
  };

  input.value = '';
  renderChips();
  renderFavoritos();
  atualizarLegenda();
  mostrarStatus(`🔍 Localizando ônibus da Linha ${linha}...`);

  await atualizarDadosLinha(linha, true);
}

function removerLinha(linha) {
  const info = linhasAtivas[linha];
  if (!info) return;

  map.removeLayer(info.layerGroup);

  if (veiculoSelecionado && veiculoSelecionado.linha === linha) {
    limparSelecao();
  }

  delete linhasAtivas[linha];
  renderChips();
  renderFavoritos();
  atualizarLegenda();
  atualizarStatusGeral();
}

function mudarCorLinha(linha, novaCor) {
  const info = linhasAtivas[linha];
  if (!info) return;
  info.cor = novaCor;

  // Atualiza marcadores existentes da linha
  info.markers.forEach((marker, id) => {
    const isSel = veiculoSelecionado && veiculoSelecionado.linha === linha && veiculoSelecionado.id === id;
    marker.setIcon(criarPinIcone(linha, novaCor, isSel));
  });

  renderChips();
  atualizarLegenda();
}

function renderChips() {
  const container = document.getElementById('chipsContainer');
  container.innerHTML = '';

  const favs = carregarFavoritos();

  Object.keys(linhasAtivas).forEach(linha => {
    const info = linhasAtivas[linha];
    const isFav = favs.includes(linha);

    const chip = document.createElement('div');
    chip.className = 'line-chip' + (isFav ? ' is-fav' : '');

    // Seletor de cor
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'color-picker-input';
    colorInput.value = info.cor;
    colorInput.title = 'Mudar cor no mapa';
    colorInput.onchange = (e) => mudarCorLinha(linha, e.target.value);

    // Texto da linha
    const label = document.createElement('span');
    label.textContent = `Linha ${linha}`;

    // Botão Favorito
    const favBtn = document.createElement('button');
    favBtn.className = 'chip-fav' + (isFav ? ' active' : '');
    favBtn.type = 'button';
    favBtn.title = isFav ? 'Desafixar dos favoritos' : 'Fixar nos favoritos';
    favBtn.textContent = isFav ? '★' : '☆';
    favBtn.onclick = () => alternarFavorito(linha);

    // Botão Remover
    const removeBtn = document.createElement('button');
    removeBtn.className = 'chip-remove';
    removeBtn.type = 'button';
    removeBtn.textContent = '×';
    removeBtn.title = `Remover Linha ${linha}`;
    removeBtn.onclick = () => removerLinha(linha);

    chip.append(colorInput, label, favBtn, removeBtn);
    container.appendChild(chip);
  });
}

function renderFavoritos() {
  const section = document.getElementById('favSection');
  const container = document.getElementById('favChipsContainer');
  const favs = carregarFavoritos().filter(l => !linhasAtivas[l]);

  if (!favs.length) {
    section.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  section.style.display = 'block';
  container.innerHTML = '';

  favs.forEach(linha => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fav-chip';
    btn.textContent = `⭐ ${linha}`;
    btn.title = `Monitorar linha ${linha}`;
    btn.onclick = () => adicionarLinha(linha);
    container.appendChild(btn);
  });
}

function mostrarStatus(mensagem) {
  const el = document.getElementById('status-msg');
  if (el) el.textContent = mensagem;
}

// ==================== RENDERIZAÇÃO DE VEÍCULOS NO MAPA ====================
function desenharVeiculosDaLinha(linha, veiculos) {
  const info = linhasAtivas[linha];
  if (!info) return;

  const idsPresentes = new Set();

  veiculos.forEach(bus => {
    const id = bus.ordem;
    idsPresentes.add(id);

    const pos = [bus.latitude, bus.longitude];
    const isSel = veiculoSelecionado && veiculoSelecionado.linha === linha && veiculoSelecionado.id === id;

    let marker = info.markers.get(id);

    if (!marker) {
      marker = L.marker(pos, {
        icon: criarPinIcone(linha, info.cor, isSel),
        zIndexOffset: isSel ? 2000 : 1000
      }).addTo(info.layerGroup);

      info.markers.set(id, marker);
    } else {
      marker.setLatLng(pos);
      marker.setIcon(criarPinIcone(linha, info.cor, isSel));
    }

    // Popup estilo Apple Maps
    const horaData = new Date(bus.timestamp);
    const popupHtml = `
      <div class="popup">
        <div class="popup-title" style="color:${info.cor};">Linha ${sanitizarTexto(linha)}</div>
        <div><b>Veículo:</b> ${sanitizarTexto(bus.ordem)}</div>
        <div><b>Velocidade:</b> ${formatarVelocidade(bus.velocidade)}</div>
        <div><b>Sentido:</b> ${sanitizarTexto(bus.direcao)}</div>
        <div class="popup-muted">
          Atualizado: ${formatarDataHora(horaData)} (${calcularIdadeMinutos(bus.timestamp) || 'recente'})
        </div>
        <button class="popup-select-btn" onclick="selecionarVeiculo('${linha}','${id}')">
          📍 Inspecionar este carro
        </button>
      </div>
    `;
    marker.bindPopup(popupHtml);
  });

  // Remove veículos que não estão mais presentes
  info.markers.forEach((marker, id) => {
    if (!idsPresentes.has(id)) {
      info.layerGroup.removeLayer(marker);
      info.markers.delete(id);
    }
  });

  if (veiculoSelecionado && veiculoSelecionado.linha === linha) {
    atualizarPainelSelecionado();
  }
}

async function atualizarDadosLinha(linha, darZoomSePrimeiraVez = false) {
  const info = linhasAtivas[linha];
  if (!info) return;

  const resultado = await buscarOnibusDaLinhaNaAPI(linha);

  if (resultado.sucesso && resultado.veiculos.length > 0) {
    info.veiculos = resultado.veiculos;
    info.modoDemo = false;
  } else {
    // Caso a API pública da SMTR não responda (CORS / queda de servidor),
    // usa os veículos demonstrativos para manter a interface utilizável
    info.veiculos = gerarVeiculosDemo(linha);
    info.modoDemo = true;
  }

  desenharVeiculosDaLinha(linha, info.veiculos);

  if (darZoomSePrimeiraVez && info.veiculos.length > 0) {
    const pontos = info.veiculos.map(b => [b.latitude, b.longitude]);
    if (pontos.length === 1) {
      map.setView(pontos[0], 14);
    } else {
      map.fitBounds(pontos, { padding: [60, 60], maxZoom: 14 });
    }
  }

  atualizarLegenda();
  atualizarStatusGeral();
}

async function atualizarTodasAsLinhas() {
  const linhas = Object.keys(linhasAtivas);
  if (!linhas.length) return;

  await Promise.allSettled(linhas.map(l => atualizarDadosLinha(l, false)));
}

// ==================== INSPETOR DE VEÍCULO (BOTTOM SHEET) ====================
function selecionarVeiculo(linha, id) {
  veiculoSelecionado = { linha, id };

  // Atualiza os marcadores no mapa
  Object.keys(linhasAtivas).forEach(l => {
    const info = linhasAtivas[l];
    info.markers.forEach((marker, busId) => {
      const isSel = l === linha && busId === id;
      marker.setIcon(criarPinIcone(l, info.cor, isSel));
      if (isSel) marker.setZIndexOffset(2500);
      else marker.setZIndexOffset(1000);
    });
  });

  atualizarPainelSelecionado();

  // Centraliza o mapa suavemente no ônibus
  const info = linhasAtivas[linha];
  if (info) {
    const bus = info.veiculos.find(b => b.ordem === id);
    if (bus) {
      map.panTo([bus.latitude, bus.longitude]);
    }
  }
}

function limparSelecao() {
  veiculoSelecionado = null;
  document.getElementById('selectedPanel').classList.remove('visible');

  Object.keys(linhasAtivas).forEach(l => {
    const info = linhasAtivas[l];
    info.markers.forEach((marker) => {
      marker.setIcon(criarPinIcone(l, info.cor, false));
      marker.setZIndexOffset(1000);
    });
  });
}

function atualizarPainelSelecionado() {
  const painel = document.getElementById('selectedPanel');
  if (!veiculoSelecionado) {
    painel.classList.remove('visible');
    return;
  }

  const info = linhasAtivas[veiculoSelecionado.linha];
  if (!info) {
    limparSelecao();
    return;
  }

  const bus = info.veiculos.find(b => b.ordem === veiculoSelecionado.id);
  if (!bus) {
    document.getElementById('selectedPanelTitle').textContent = `Linha ${veiculoSelecionado.linha} · Carro ${veiculoSelecionado.id}`;
    document.getElementById('selectedPanelBody').innerHTML = `<div style="grid-column:1/-1;color:var(--warning)">⚠️ Sinal GPS não recebido nesta rodada.</div>`;
    painel.classList.add('visible');
    return;
  }

  document.getElementById('selectedPanelTitle').textContent = `Linha ${bus.linha} · Carro ${bus.ordem}`;
  document.getElementById('selectedPanelBody').innerHTML = `
    <div><b>Velocidade:</b> ${formatarVelocidade(bus.velocidade)}</div>
    <div><b>Sentido:</b> ${sanitizarTexto(bus.direcao)}</div>
    <div><b>GPS:</b> ${calcularIdadeMinutos(bus.timestamp) || 'recente'}</div>
    <div><b>Hora:</b> ${formatarDataHora(new Date(bus.timestamp))}</div>
  `;
  painel.classList.add('visible');
}

// ==================== STATUS E LEGENDA ====================
function atualizarLegenda() {
  const div = document.getElementById('mapLegend');
  if (!div) return;

  const chaves = Object.keys(linhasAtivas);
  if (!chaves.length) {
    div.style.display = 'none';
    div.innerHTML = '';
    return;
  }

  div.style.display = 'block';
  div.innerHTML = chaves.map(linha => {
    const info = linhasAtivas[linha];
    const total = info.veiculos.length;
    const fonte = info.modoDemo ? 'simulação' : 'GPS ao vivo';
    return `
      <div class="legend-row">
        <span class="legend-dot" style="background:${info.cor};"></span>
        <span><b style="color:${info.cor};">Linha ${linha}</b> · ${total} ônibus (${fonte})</span>
      </div>
    `;
  }).join('');
}

function atualizarStatusGeral() {
  const chaves = Object.keys(linhasAtivas);
  if (!chaves.length) {
    mostrarStatus('Adicione uma linha acima para iniciar o monitoramento.');
    return;
  }

  const totalBuses = chaves.reduce((acc, l) => acc + linhasAtivas[l].veiculos.length, 0);
  const temDemo = chaves.some(l => linhasAtivas[l].modoDemo);

  let msg = `🚌 ${chaves.length} linha(s) | ${totalBuses} ônibus em circulação`;
  if (temDemo) {
    msg += ` | ⚠️ SMTR indisponível (exibindo estimativa)`;
  } else {
    msg += ` | ⚡ GPS SMTR ativo`;
  }

  mostrarStatus(msg);
}

// ==================== GEOLOCALIZAÇÃO DO USUÁRIO ====================
function localizarUsuario() {
  const btn = document.getElementById('btnGeo');
  if (!navigator.geolocation) {
    alert('📍 Geolocalização não suportada pelo seu navegador.');
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ Localizando...';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;

      // Remove marcadores anteriores
      if (userMarker) map.removeLayer(userMarker);
      if (userAccuracyCircle) map.removeLayer(userAccuracyCircle);

      // Círculo de precisão e ponto azul estilo Apple Maps
      userAccuracyCircle = L.circle([lat, lng], {
        radius: accuracy,
        color: '#007aff',
        fillColor: '#007aff',
        fillOpacity: 0.15,
        weight: 1
      }).addTo(map);

      userMarker = L.circleMarker([lat, lng], {
        radius: 9,
        fillColor: '#007aff',
        color: '#ffffff',
        weight: 3,
        opacity: 1,
        fillOpacity: 1
      }).addTo(map);

      userMarker.bindPopup(`📍 <b>Sua Localização</b><br><span style="font-size:11px;color:#6b7280">Precisão: ~${Math.round(accuracy)}m</span>`).openPopup();

      map.setView([lat, lng], 15);

      btn.disabled = false;
      btn.textContent = '📍 Onde estou';
    },
    (err) => {
      btn.disabled = false;
      btn.textContent = '📍 Onde estou';
      let motivo = 'Não foi possível obter sua localização.';
      if (err.code === 1) motivo = 'Permissão de localização negada.';
      else if (err.code === 2) motivo = 'Sinal de GPS indisponível.';
      else if (err.code === 3) motivo = 'Tempo limite esgotado.';
      alert('📍 ' + motivo);
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}

// ==================== INICIALIZAÇÃO ====================
function inicializarApp() {
  const input = document.getElementById('linhaInput');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        adicionarLinha();
      }
    });
  }

  renderFavoritos();
  atualizarLegenda();
  atualizarStatusGeral();

  // Inicia loop de atualização periódica
  if (intervaloAtualizacao) clearInterval(intervaloAtualizacao);
  intervaloAtualizacao = setInterval(atualizarTodasAsLinhas, CONFIG.INTERVALO_ATUALIZACAO);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', inicializarApp);
} else {
  inicializarApp();
}

