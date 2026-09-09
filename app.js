/**
 * Cadê o Ônibus? • Mobilidade Carioca
 * Webapp de monitoramento de ônibus em tempo real para o Rio de Janeiro
 * - GPS ao vivo oficial da SMTR (dados.mobilidade.rio)
 * - Itinerários oficiais (shapes) e paradas (stops) extraídos do GTFS da cidade
 * - Motor de Dead Reckoning a 60 FPS: ônibus deslizam suavemente na velocidade real
 * - Visual elegante estilo Apple Maps (CartoDB Voyager / OpenStreetMap)
 */

// ==================== CONFIGURAÇÃO ====================
const CONFIG = {
  API_URL: 'https://dados.mobilidade.rio/gps/sppo',
  INTERVALO_ATUALIZACAO: 15000, // Consulta GPS a cada 15s
  JANELA_SEGUNDOS: 25,          // Janela ideal da API: ~25s (~900KB, ~2.800 veículos)
  TIMEOUT_REQUISICAO: 14000,
  CORES_DEFAULT: ['#1b6354', '#e65100', '#1565c0', '#7b1fa2', '#c62828', '#0284c7', '#2e7d32', '#d97706'],
  STORAGE_KEY_FAVORITOS: 'cadeoonibus_favoritos_v1'
};

// ==================== ESTADO GLOBAL ====================
const linhasAtivas = {}; 
let corIndex = 0;
let veiculoSelecionado = null; // { linha, id }
let userMarker = null;
let userAccuracyCircle = null;
let intervaloAtualizacao = null;
let atualizacaoEmAndamento = false;

// Cache da frota municipal
const cacheFrota = {
  timestamp: 0,
  dados: []
};

// ==================== MAPA (ESTILO APPLE MAPS) ====================
const map = L.map('map', {
  zoomControl: false,
  preferCanvas: true
}).setView([-22.9068, -43.1729], 13); // Centro do Rio

L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank">CARTO</a>',
  subdomains: 'abcd',
  maxZoom: 19
}).addTo(map);

L.control.zoom({ position: 'bottomright' }).addTo(map);

// Evita mapa com dimensões nulas em flexbox
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
  return Number.isFinite(v) && v > 0 ? `${Math.round(v)} km/h` : 'Parado';
}

function calcularIdade(timestamp) {
  if (!timestamp) return 'recente';
  const ms = Math.max(0, Date.now() - timestamp);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `há ${s}s`;
  const m = Math.floor(s / 60);
  return `há ${m} min`;
}

// ==================== FAVORITOS ====================
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
  } catch {}
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

// ==================== ITINERÁRIOS E PARADAS (GTFS) ====================
async function carregarItinerario(linha, cor) {
  const info = linhasAtivas[linha];
  if (!info) return;

  try {
    const res = await fetch(`routes/${encodeURIComponent(linha)}.json`);
    if (!res.ok) return;

    const dados = await res.json();
    if (!dados || !linhasAtivas[linha]) return;

    info.routeLayer.clearLayers();
    info.stopsLayer.clearLayers();

    // Traçado de Ida (Linha sólida suave)
    if (dados.ida && Array.isArray(dados.ida.shape) && dados.ida.shape.length > 1) {
      const polyIda = L.polyline(dados.ida.shape, {
        color: cor,
        weight: 4.5,
        opacity: 0.8,
        lineCap: 'round',
        lineJoin: 'round'
      });
      polyIda.bindPopup(`<b>Linha ${sanitizarTexto(linha)} (Ida)</b><br>Destino: ${sanitizarTexto(dados.ida.destino)}`);
      info.routeLayer.addLayer(polyIda);
    }

    // Traçado de Volta (Linha tracejada suave)
    if (dados.volta && Array.isArray(dados.volta.shape) && dados.volta.shape.length > 1) {
      const polyVolta = L.polyline(dados.volta.shape, {
        color: cor,
        weight: 3.5,
        opacity: 0.65,
        dashArray: '6, 8',
        lineCap: 'round',
        lineJoin: 'round'
      });
      polyVolta.bindPopup(`<b>Linha ${sanitizarTexto(linha)} (Volta)</b><br>Destino: ${sanitizarTexto(dados.volta.destino)}`);
      info.routeLayer.addLayer(polyVolta);
    }

    // Pontos de Parada Oficiais
    const adicionarParadas = (paradas, sentidoLabel) => {
      if (!Array.isArray(paradas)) return;
      paradas.forEach(p => {
        const marker = L.circleMarker([p.lat, p.lng], {
          radius: 4,
          fillColor: '#ffffff',
          color: cor,
          weight: 2,
          opacity: 0.9,
          fillOpacity: 1
        });
        marker.bindPopup(`
          <div class="stop-popup">
            <div class="stop-popup-title">🚏 ${sanitizarTexto(p.nome)}</div>
            <div class="stop-popup-sub">Linha ${sanitizarTexto(linha)} · ${sentidoLabel}</div>
          </div>
        `);
        info.stopsLayer.addLayer(marker);
      });
    };

    if (dados.ida && dados.ida.stops) adicionarParadas(dados.ida.stops, 'Ida');
    if (dados.volta && dados.volta.stops) adicionarParadas(dados.volta.stops, 'Volta');

    info.itinerarioCarregado = true;

    if (info.routeVisible) {
      info.routeLayer.addTo(map);
      if (map.getZoom() >= 14) {
        info.stopsLayer.addTo(map);
      }
    }
  } catch (err) {
    console.warn(`[Cadê o Ônibus] Itinerário da linha ${linha} não encontrado:`, err.message);
  }
}

function alternarRota(linha) {
  const info = linhasAtivas[linha];
  if (!info) return;

  info.routeVisible = !info.routeVisible;

  if (info.routeVisible) {
    info.routeLayer.addTo(map);
    if (map.getZoom() >= 14) {
      info.stopsLayer.addTo(map);
    }
  } else {
    map.removeLayer(info.routeLayer);
    map.removeLayer(info.stopsLayer);
  }

  renderChips();
}

// Controle de visibilidade das paradas conforme o zoom do mapa
function atualizarVisibilidadeParadas() {
  const zoom = map.getZoom();
  Object.values(linhasAtivas).forEach(info => {
    if (!info.routeVisible || !info.itinerarioCarregado) return;
    if (zoom >= 14) {
      if (!map.hasLayer(info.stopsLayer)) {
        info.stopsLayer.addTo(map);
      }
    } else {
      if (map.hasLayer(info.stopsLayer)) {
        map.removeLayer(info.stopsLayer);
      }
    }
  });
}
map.on('zoomend', atualizarVisibilidadeParadas);

// ==================== GPS OFICIAL EM TEMPO REAL ====================
function getUrlConsultaSMTR() {
  const agora = new Date();
  const inicio = new Date(agora.getTime() - CONFIG.JANELA_SEGUNDOS * 1000);

  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}+${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  return `${CONFIG.API_URL}?dataInicial=${fmt(inicio)}&dataFinal=${fmt(agora)}`;
}

async function obterFrotaRioEmTempoReal() {
  const agora = Date.now();

  if (agora - cacheFrota.timestamp < 10000 && cacheFrota.dados.length > 0) {
    return cacheFrota.dados;
  }

  const endpointAlvo = getUrlConsultaSMTR();

  const proxies = [
    `https://api.allorigins.win/raw?url=${encodeURIComponent(endpointAlvo)}`,
    `https://cors.eu.org/${endpointAlvo}`
  ];

  for (const proxyUrl of proxies) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG.TIMEOUT_REQUISICAO);

      const res = await fetch(proxyUrl, { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) continue;

      const texto = await res.text();
      if (!texto.trim().startsWith('[')) continue;

      const lista = JSON.parse(texto);
      if (Array.isArray(lista) && lista.length > 0) {
        cacheFrota.timestamp = agora;
        cacheFrota.dados = lista;
        return lista;
      }
    } catch (e) {
      console.warn('[Cadê o Ônibus] Erro na consulta via proxy:', e.message);
    }
  }

  return cacheFrota.dados;
}

function filtrarOnibusDaLinha(frota, linhaAlvo) {
  const alvo = normalizarNumeroLinha(linhaAlvo);
  const porCarro = new Map();

  for (const item of frota) {
    const servico = normalizarNumeroLinha(item.servico || item.linha || item.route_id);
    if (servico !== alvo && !servico.endsWith(alvo)) continue;

    const id = String(item.id_veiculo || item.ordem || '').trim();
    if (!id) continue;

    const lat = Number(item.latitude);
    const lng = Number(item.longitude);
    if (!lat || !lng || isNaN(lat) || isNaN(lng) || lat === 0) continue;

    const sentidoBruto = String(item.sentido || '').toUpperCase();
    const sentido = sentidoBruto === 'I' ? 'Ida' : (sentidoBruto === 'V' ? 'Volta' : 'Em trânsito');

    const timestampMs = item.datetime ? new Date(item.datetime).getTime() : Date.now();

    const veiculo = {
      ordem: id,
      linha: linhaAlvo,
      latitude: lat,
      longitude: lng,
      velocidade: Number(item.velocidade || 0),
      direcao: Number(item.direcao || 0),
      sentido: sentido,
      timestamp: timestampMs
    };

    if (!porCarro.has(id) || porCarro.get(id).timestamp < timestampMs) {
      porCarro.set(id, veiculo);
    }
  }

  return Array.from(porCarro.values());
}

// ==================== ÍCONES E MARCADORES ====================
function criarPinIcone(linha, cor, direcao, isSelecionado) {
  const classes = ['bus-marker-pin'];
  if (isSelecionado) classes.push('selected');

  // Seta orientada pela bússola real do GPS
  const setaHtml = Number.isFinite(direcao) && direcao > 0
    ? `<span style="display:inline-block; transform: rotate(${direcao}deg); font-size:10px; margin-left:3px;">▲</span>`
    : '';

  return L.divIcon({
    className: 'custom-bus-pin',
    html: `<div class="${classes.join(' ')}" style="background:${cor}; border-color:#fff;">🚌 ${sanitizarTexto(linha)}${setaHtml}</div>`,
    iconSize: [68, 24],
    iconAnchor: [34, 12],
    popupAnchor: [0, -12]
  });
}

function processarNovosVeiculos(linha, novosDados) {
  const info = linhasAtivas[linha];
  if (!info) return;

  const idsPresentes = new Set();

  novosDados.forEach(novo => {
    const id = novo.ordem;
    idsPresentes.add(id);

    let busState = info.veiculos.find(b => b.ordem === id);

    if (!busState) {
      // Novo veículo no mapa
      busState = {
        ordem: id,
        linha: linha,
        currentLat: novo.latitude,
        currentLng: novo.longitude,
        targetLat: novo.latitude,
        targetLng: novo.longitude,
        velocidade: novo.velocidade,
        direcao: novo.direcao,
        sentido: novo.sentido,
        timestamp: novo.timestamp
      };
      info.veiculos.push(busState);

      const isSel = veiculoSelecionado && veiculoSelecionado.linha === linha && veiculoSelecionado.id === id;
      const marker = L.marker([busState.currentLat, busState.currentLng], {
        icon: criarPinIcone(linha, info.cor, busState.direcao, isSel),
        zIndexOffset: isSel ? 2000 : 1000
      }).addTo(info.layerGroup);

      info.markers.set(id, marker);
    } else {
      // Veículo já existente: atualiza o alvo do GPS para interpolação suave
      busState.targetLat = novo.latitude;
      busState.targetLng = novo.longitude;
      busState.velocidade = novo.velocidade;
      busState.direcao = novo.direcao;
      busState.sentido = novo.sentido;
      busState.timestamp = novo.timestamp;

      const marker = info.markers.get(id);
      if (marker) {
        const isSel = veiculoSelecionado && veiculoSelecionado.linha === linha && veiculoSelecionado.id === id;
        marker.setIcon(criarPinIcone(linha, info.cor, busState.direcao, isSel));
      }
    }

    // Atualiza popup
    const marker = info.markers.get(id);
    if (marker) {
      const horaData = new Date(busState.timestamp);
      marker.bindPopup(`
        <div class="popup">
          <div class="popup-title" style="color:${info.cor};">Linha ${sanitizarTexto(linha)}</div>
          <div><b>Veículo:</b> ${sanitizarTexto(busState.ordem)}</div>
          <div><b>Sentido:</b> ${sanitizarTexto(busState.sentido)}</div>
          <div><b>Velocidade:</b> ${formatarVelocidade(busState.velocidade)}</div>
          <div class="popup-muted">
            GPS: ${calcularIdade(busState.timestamp)} (${formatarDataHora(horaData)})
          </div>
          <button class="popup-select-btn" onclick="selecionarVeiculo('${linha}','${id}')">
            📍 Acompanhar este carro
          </button>
        </div>
      `);
    }
  });

  // Remove veículos que saíram do sinal
  info.veiculos = info.veiculos.filter(b => {
    if (!idsPresentes.has(b.ordem)) {
      const marker = info.markers.get(b.ordem);
      if (marker) {
        info.layerGroup.removeLayer(marker);
        info.markers.delete(b.ordem);
      }
      return false;
    }
    return true;
  });

  if (veiculoSelecionado && veiculoSelecionado.linha === linha) {
    atualizarPainelSelecionado();
  }
}

// ==================== MOTOR DE DEAD RECKONING (60 FPS) ====================
let ultimoFrameTime = performance.now();

function animarVeiculosLoop(tempoAtual) {
  // Intervalo de tempo entre frames (limitado a 0.1s para evitar saltos ao trocar de aba)
  const dt = Math.min((tempoAtual - ultimoFrameTime) / 1000, 0.1);
  ultimoFrameTime = tempoAtual;

  Object.entries(linhasAtivas).forEach(([linha, info]) => {
    info.veiculos.forEach(bus => {
      // 1. Interpolação suave para a nova coordenada GPS reportada pela SMTR
      const dLatAlvo = bus.targetLat - bus.currentLat;
      const dLngAlvo = bus.targetLng - bus.currentLng;
      const distAlvoGraus = Math.hypot(dLatAlvo, dLngAlvo);

      if (distAlvoGraus > 0.00002) {
        // Convergência suave (~1.5s) sem teletransporte
        const fatorSuavizacao = Math.min(1, dt * 2.5);
        bus.currentLat += dLatAlvo * fatorSuavizacao;
        bus.currentLng += dLngAlvo * fatorSuavizacao;
      } else {
        // 2. Dead Reckoning: Se está alinhado e em movimento, avança na velocidade real reportada
        if (bus.velocidade > 3 && bus.direcao > 0) {
          const speedMps = (bus.velocidade * 1000) / 3600; // km/h -> m/s
          const distMetros = speedMps * dt;
          const rad = (bus.direcao * Math.PI) / 180;
          
          // Conversão de metros para graus de latitude e longitude
          const deltaLat = (distMetros * Math.cos(rad)) / 111320;
          const deltaLng = (distMetros * Math.sin(rad)) / (111320 * Math.cos((bus.currentLat * Math.PI) / 180));

          bus.currentLat += deltaLat;
          bus.currentLng += deltaLng;
        }
      }

      // 3. Atualiza marcador no mapa
      const marker = info.markers.get(bus.ordem);
      if (marker) {
        marker.setLatLng([bus.currentLat, bus.currentLng]);
      }
    });
  });

  // Acompanhamento suave da câmera se houver carro selecionado
  if (veiculoSelecionado) {
    const info = linhasAtivas[veiculoSelecionado.linha];
    if (info) {
      const bus = info.veiculos.find(b => b.ordem === veiculoSelecionado.id);
      if (bus && !map.getBounds().pad(-0.1).contains([bus.currentLat, bus.currentLng])) {
        map.panTo([bus.currentLat, bus.currentLng], { animate: true, duration: 0.6 });
      }
    }
  }

  requestAnimationFrame(animarVeiculosLoop);
}

// Inicia animação a 60 FPS
requestAnimationFrame(animarVeiculosLoop);

// ==================== ATUALIZAÇÃO PERIÓDICA ====================
async function atualizarTodasAsLinhas(darZoomNaLinha = null) {
  if (atualizacaoEmAndamento) return;
  const linhas = Object.keys(linhasAtivas);
  if (!linhas.length) {
    atualizarStatusGeral();
    return;
  }

  atualizacaoEmAndamento = true;

  try {
    const frota = await obterFrotaRioEmTempoReal();

    linhas.forEach(linha => {
      const info = linhasAtivas[linha];
      if (!info) return;

      const novosDados = filtrarOnibusDaLinha(frota, linha);
      processarNovosVeiculos(linha, novosDados);

      // Enquadra os ônibus da linha no primeiro carregamento
      if (darZoomNaLinha === linha && info.veiculos.length > 0) {
        const pontos = info.veiculos.map(b => [b.currentLat, b.currentLng]);
        if (pontos.length === 1) {
          map.setView(pontos[0], 14);
        } else {
          map.fitBounds(pontos, { padding: [70, 70], maxZoom: 15 });
        }
      }
    });

    atualizarLegenda();
    atualizarStatusGeral();
  } catch (err) {
    console.error('[Cadê o Ônibus] Erro na rodada de atualização:', err);
  } finally {
    atualizacaoEmAndamento = false;
  }
}

// ==================== CONTROLE DE LINHAS E INTERFACE ====================
function atalhoLinha(linha) {
  document.getElementById('linhaInput').value = linha;
  adicionarLinha(linha);
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
    layerGroup: L.layerGroup().addTo(map), // Ônibus
    routeLayer: L.layerGroup(),            // Itinerário (shapes)
    stopsLayer: L.layerGroup(),            // Paradas (stops)
    routeVisible: true,
    itinerarioCarregado: false,
    markers: new Map(),
    veiculos: []
  };

  input.value = '';
  renderChips();
  renderFavoritos();
  atualizarLegenda();
  mostrarStatus(`🔍 Localizando Linha ${linha} e itinerário...`);

  // Carrega trajeto e paradas oficiais em paralelo
  carregarItinerario(linha, cor);

  await atualizarTodasAsLinhas(linha);
}

function removerLinha(linha) {
  const info = linhasAtivas[linha];
  if (!info) return;

  map.removeLayer(info.layerGroup);
  map.removeLayer(info.routeLayer);
  map.removeLayer(info.stopsLayer);

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

  // Atualiza marcadores de ônibus
  info.markers.forEach((marker, id) => {
    const isSel = veiculoSelecionado && veiculoSelecionado.linha === linha && veiculoSelecionado.id === id;
    const bus = info.veiculos.find(b => b.ordem === id);
    marker.setIcon(criarPinIcone(linha, novaCor, bus ? bus.direcao : 0, isSel));
  });

  // Atualiza trajeto e paradas
  carregarItinerario(linha, novaCor);

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

    // Rótulo
    const label = document.createElement('span');
    label.textContent = `Linha ${linha}`;

    // Botão de Itinerário / Paradas
    const routeBtn = document.createElement('button');
    routeBtn.className = 'chip-route' + (info.routeVisible ? ' active' : '');
    routeBtn.type = 'button';
    routeBtn.title = info.routeVisible ? 'Ocultar trajeto e paradas' : 'Exibir trajeto e paradas';
    routeBtn.textContent = '〰️';
    routeBtn.onclick = () => alternarRota(linha);

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

    chip.append(colorInput, label, routeBtn, favBtn, removeBtn);
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

// ==================== INSPETOR DE VEÍCULO (BOTTOM SHEET) ====================
function selecionarVeiculo(linha, id) {
  veiculoSelecionado = { linha, id };

  Object.keys(linhasAtivas).forEach(l => {
    const info = linhasAtivas[l];
    info.markers.forEach((marker, busId) => {
      const isSel = l === linha && busId === id;
      const bus = info.veiculos.find(b => b.ordem === busId);
      marker.setIcon(criarPinIcone(l, info.cor, bus ? bus.direcao : 0, isSel));
      if (isSel) marker.setZIndexOffset(2500);
      else marker.setZIndexOffset(1000);
    });
  });

  atualizarPainelSelecionado();

  const info = linhasAtivas[linha];
  if (info) {
    const bus = info.veiculos.find(b => b.ordem === id);
    if (bus) {
      map.panTo([bus.currentLat, bus.currentLng], { animate: true, duration: 0.5 });
    }
  }
}

function limparSelecao() {
  veiculoSelecionado = null;
  document.getElementById('selectedPanel').classList.remove('visible');

  Object.keys(linhasAtivas).forEach(l => {
    const info = linhasAtivas[l];
    info.markers.forEach((marker, busId) => {
      const bus = info.veiculos.find(b => b.ordem === busId);
      marker.setIcon(criarPinIcone(l, info.cor, bus ? bus.direcao : 0, false));
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
    document.getElementById('selectedPanelBody').innerHTML = `<div style="grid-column:1/-1;color:var(--warning)">⚠️ Carro fora do sinal GPS na última atualização.</div>`;
    painel.classList.add('visible');
    return;
  }

  document.getElementById('selectedPanelTitle').textContent = `Linha ${bus.linha} · Carro ${bus.ordem}`;
  document.getElementById('selectedPanelBody').innerHTML = `
    <div><b>Sentido:</b> ${sanitizarTexto(bus.sentido)}</div>
    <div><b>Velocidade:</b> ${formatarVelocidade(bus.velocidade)}</div>
    <div><b>GPS:</b> ${calcularIdade(bus.timestamp)}</div>
    <div><b>Atualizado:</b> ${formatarDataHora(new Date(bus.timestamp))}</div>
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
    return `
      <div class="legend-row">
        <span class="legend-dot" style="background:${info.cor};"></span>
        <span><b style="color:${info.cor};">Linha ${linha}</b> · ${total} ônibus ao vivo</span>
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

  if (totalBuses === 0) {
    mostrarStatus(`⚠️ Nenhum ônibus transmitindo sinal GPS para as linhas monitoradas agora.`);
  } else {
    mostrarStatus(`⚡ GPS Oficial SMTR • ${chaves.length} linha(s) | ${totalBuses} ônibus em tempo real`);
  }
}

// ==================== GEOLOCALIZAÇÃO ====================
function localizarUsuario() {
  const btn = document.getElementById('btnGeo');
  if (!navigator.geolocation) {
    alert('📍 Geolocalização não suportada pelo seu dispositivo.');
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ Localizando...';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;

      if (userMarker) map.removeLayer(userMarker);
      if (userAccuracyCircle) map.removeLayer(userAccuracyCircle);

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

  if (intervaloAtualizacao) clearInterval(intervaloAtualizacao);
  intervaloAtualizacao = setInterval(() => atualizarTodasAsLinhas(), CONFIG.INTERVALO_ATUALIZACAO);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', inicializarApp);
} else {
  inicializarApp();
}
