/**
 * Cadê o Ônibus? • Mobilidade Carioca
 * Webapp de monitoramento de ônibus em tempo real para a cidade do Rio de Janeiro
 * Conecta-se diretamente ao feed de GPS oficial da SMTR (SPPO / Prefeitura do Rio)
 * Visual limpo inspirado no Apple Maps (OpenStreetMap via CartoDB Voyager)
 */

// ==================== CONFIGURAÇÃO ====================
const CONFIG = {
  API_URL: 'https://dados.mobilidade.rio/gps/sppo',
  INTERVALO_ATUALIZACAO: 15000, // Atualiza a cada 15 segundos
  JANELA_SEGUNDOS: 25,          // Consulta os últimos 25s (tamanho ideal de ~900KB com ~2.800 ônibus)
  TIMEOUT_REQUISICAO: 14000,
  CORES_DEFAULT: ['#1b6354', '#e65100', '#1565c0', '#7b1fa2', '#c62828', '#0284c7', '#2e7d32', '#d97706'],
  STORAGE_KEY_FAVORITOS: 'cadeoonibus_favoritos_v1'
};

// ==================== ESTADO GLOBAL ====================
const linhasAtivas = {}; // { [linha]: { cor, markers: Map, veiculos: Array } }
let corIndex = 0;
let veiculoSelecionado = null; // { linha, id }
let userMarker = null;
let userAccuracyCircle = null;
let intervaloAtualizacao = null;
let atualizacaoEmAndamento = false;

// Cache da frota da cidade para evitar múltiplos downloads na mesma rodada
const cacheFrota = {
  timestamp: 0,
  dados: []
};

// ==================== INICIALIZAÇÃO DO MAPA (ESTILO APPLE MAPS) ====================
const map = L.map('map', {
  zoomControl: false,
  preferCanvas: true
}).setView([-22.9068, -43.1729], 13); // Centro do Rio

// CartoDB Voyager: estilo claro, minimalista e elegante (idêntico ao Apple Maps iOS)
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank">CARTO</a>',
  subdomains: 'abcd',
  maxZoom: 19
}).addTo(map);

L.control.zoom({ position: 'bottomright' }).addTo(map);

// Evita mapa cinza/cortado em telas móveis e desktop
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
    // Ignora restrições de localStorage em modo privado
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

// ==================== INTEGRAÇÃO GPS OFICIAL SMTR ====================
/**
 * Constrói a URL com a janela de tempo dos últimos segundos
 * Formato oficial exigido pela SMTR: dataInicial=AAAA-MM-DD+HH:MM:SS&dataFinal=AAAA-MM-DD+HH:MM:SS
 */
function getUrlConsultaSMTR() {
  const agora = new Date();
  const inicio = new Date(agora.getTime() - CONFIG.JANELA_SEGUNDOS * 1000);

  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}+${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  return `${CONFIG.API_URL}?dataInicial=${fmt(inicio)}&dataFinal=${fmt(agora)}`;
}

/**
 * Baixa os dados em tempo real da frota do Rio de Janeiro via proxy CORS validado.
 * Como o retorno contém todos os ônibus da cidade ativos no momento (~2.800 veículos),
 * fazemos uma única requisição por ciclo para alimentar todas as linhas ativas.
 */
async function obterFrotaRioEmTempoReal() {
  const agora = Date.now();

  // Reutiliza cache se foi baixado há menos de 10 segundos
  if (agora - cacheFrota.timestamp < 10000 && cacheFrota.dados.length > 0) {
    return cacheFrota.dados;
  }

  const endpointAlvo = getUrlConsultaSMTR();

  // Proxies CORS funcionais com fallback
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
      if (!texto.trim().startsWith('[')) continue; // Evita páginas de erro HTML

      const lista = JSON.parse(texto);
      if (Array.isArray(lista) && lista.length > 0) {
        cacheFrota.timestamp = agora;
        cacheFrota.dados = lista;
        return lista;
      }
    } catch (e) {
      console.warn('[Cadê o Ônibus] Tentativa de conexão via proxy falhou:', e.message);
    }
  }

  return cacheFrota.dados;
}

/**
 * Filtra os ônibus da frota bruta pertencentes a uma linha específica
 */
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

    // Fica com o dado mais recente de cada carro
    if (!porCarro.has(id) || porCarro.get(id).timestamp < timestampMs) {
      porCarro.set(id, veiculo);
    }
  }

  return Array.from(porCarro.values());
}

// ==================== ÍCONES E MAPA ====================
function criarPinIcone(linha, cor, direcao, isSelecionado) {
  const classes = ['bus-marker-pin'];
  if (isSelecionado) classes.push('selected');

  // Seta de direção indicando a bússola do ônibus (0° a 360°)
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

function desenharVeiculos(linha, veiculos) {
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
        icon: criarPinIcone(linha, info.cor, bus.direcao, isSel),
        zIndexOffset: isSel ? 2000 : 1000
      }).addTo(info.layerGroup);

      info.markers.set(id, marker);
    } else {
      // Move o marcador suavemente para a nova coordenada GPS
      marker.setLatLng(pos);
      marker.setIcon(criarPinIcone(linha, info.cor, bus.direcao, isSel));
    }

    // Popup com informações em tempo real
    const horaData = new Date(bus.timestamp);
    const popupHtml = `
      <div class="popup">
        <div class="popup-title" style="color:${info.cor};">Linha ${sanitizarTexto(linha)}</div>
        <div><b>Veículo:</b> ${sanitizarTexto(bus.ordem)}</div>
        <div><b>Sentido:</b> ${sanitizarTexto(bus.sentido)}</div>
        <div><b>Velocidade:</b> ${formatarVelocidade(bus.velocidade)}</div>
        <div class="popup-muted">
          GPS: ${calcularIdade(bus.timestamp)} (${formatarDataHora(horaData)})
        </div>
        <button class="popup-select-btn" onclick="selecionarVeiculo('${linha}','${id}')">
          📍 Acompanhar este carro
        </button>
      </div>
    `;
    marker.bindPopup(popupHtml);
  });

  // Remove veículos que não aparecem mais no sinal GPS
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

// ==================== ATUALIZAÇÃO DAS LINHAS ====================
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

      const veiculos = filtrarOnibusDaLinha(frota, linha);
      info.veiculos = veiculos;
      desenharVeiculos(linha, veiculos);

      // Centraliza na primeira busca
      if (darZoomNaLinha === linha && veiculos.length > 0) {
        const pontos = veiculos.map(b => [b.latitude, b.longitude]);
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
    layerGroup: L.layerGroup().addTo(map),
    markers: new Map(),
    veiculos: []
  };

  input.value = '';
  renderChips();
  renderFavoritos();
  atualizarLegenda();
  mostrarStatus(`🔍 Conectando ao GPS da SMTR para a Linha ${linha}...`);

  await atualizarTodasAsLinhas(linha);
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

  info.markers.forEach((marker, id) => {
    const isSel = veiculoSelecionado && veiculoSelecionado.linha === linha && veiculoSelecionado.id === id;
    const bus = info.veiculos.find(b => b.ordem === id);
    marker.setIcon(criarPinIcone(linha, novaCor, bus ? bus.direcao : 0, isSel));
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

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'color-picker-input';
    colorInput.value = info.cor;
    colorInput.title = 'Mudar cor no mapa';
    colorInput.onchange = (e) => mudarCorLinha(linha, e.target.value);

    const label = document.createElement('span');
    label.textContent = `Linha ${linha}`;

    const favBtn = document.createElement('button');
    favBtn.className = 'chip-fav' + (isFav ? ' active' : '');
    favBtn.type = 'button';
    favBtn.title = isFav ? 'Desafixar dos favoritos' : 'Fixar nos favoritos';
    favBtn.textContent = isFav ? '★' : '☆';
    favBtn.onclick = () => alternarFavorito(linha);

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
      map.panTo([bus.latitude, bus.longitude]);
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

// ==================== GEOLOCALIZAÇÃO DO USUÁRIO ====================
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

  // Atualização periódica automática em tempo real
  if (intervaloAtualizacao) clearInterval(intervaloAtualizacao);
  intervaloAtualizacao = setInterval(() => atualizarTodasAsLinhas(), CONFIG.INTERVALO_ATUALIZACAO);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', inicializarApp);
} else {
  inicializarApp();
}
