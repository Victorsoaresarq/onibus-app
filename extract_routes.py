#!/usr/bin/env python3
"""
Extrator de Itinerários e Paradas GTFS (SMTR / Rio de Janeiro)
Baixa o GTFS oficial e gera arquivos JSON leves para cada linha em routes/{linha}.json
"""

import urllib.request
import ssl
import zipfile
import io
import csv
import json
import os
import sys

GTFS_URL = "https://dados.mobilidade.rio/gtfs/schedule"
CACHE_ZIP = "gtfs_schedule.zip"
OUTPUT_DIR = "routes"

def download_gtfs():
    if os.path.exists(CACHE_ZIP) and os.path.getsize(CACHE_ZIP) > 1000000:
        print(f"[+] Usando arquivo em cache: {CACHE_ZIP} ({os.path.getsize(CACHE_ZIP)/(1024*1024):.1f} MB)")
        with open(CACHE_ZIP, "rb") as f:
            return f.read()
    
    print(f"[+] Baixando GTFS oficial da SMTR de: {GTFS_URL} ...")
    ctx = ssl._create_unverified_context()
    req = urllib.request.Request(GTFS_URL, headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"})
    with urllib.request.urlopen(req, context=ctx, timeout=60) as resp:
        content = resp.read()
        print(f"[+] Download concluído: {len(content)/(1024*1024):.1f} MB")
        with open(CACHE_ZIP, "wb") as f:
            f.write(content)
        return content

def simplificar_trajeto(pontos, tolerancia=0.00005):
    """
    Algoritmo Ramer-Douglas-Peucker simples para reduzir pontos redundantes na polyline
    sem perder as curvas das ruas.
    """
    if len(pontos) <= 2:
        return pontos

    def dist_ponto_reta(p, p1, p2):
        x0, y0 = p
        x1, y1 = p1
        x2, y2 = p2
        dx = x2 - x1
        dy = y2 - y1
        if dx == 0 and dy == 0:
            return ((x0 - x1)**2 + (y0 - y1)**2)**0.5
        t = ((x0 - x1) * dx + (y0 - y1) * dy) / (dx*dx + dy*dy)
        t = max(0, min(1, t))
        proj_x = x1 + t * dx
        proj_y = y1 + t * dy
        return ((x0 - proj_x)**2 + (y0 - proj_y)**2)**0.5

    dmax = 0.0
    index = 0
    p1 = pontos[0]
    p2 = pontos[-1]

    for i in range(1, len(pontos) - 1):
        d = dist_ponto_reta(pontos[i], p1, p2)
        if d > dmax:
            index = i
            dmax = d

    if dmax > tolerancia:
        rec1 = simplificar_trajeto(pontos[:index+1], tolerancia)
        rec2 = simplificar_trajeto(pontos[index:], tolerancia)
        return rec1[:-1] + rec2
    else:
        return [pontos[0], pontos[-1]]

def extrair_linhas(linhas_alvo=None):
    zip_bytes = download_gtfs()
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        print("[+] Lendo routes.txt...")
        routes_data = list(csv.DictReader(io.StringIO(z.read("routes.txt").decode("utf-8"))))

        # Mapeia rotas
        linhas_map = {}
        for r in routes_data:
            short = str(r.get("route_short_name", "")).strip().lstrip("0")
            if not short:
                continue
            if linhas_alvo and short not in linhas_alvo:
                continue
            linhas_map[r["route_id"]] = {
                "linha": short,
                "route_id": r["route_id"],
                "nome": r.get("route_long_name", ""),
                "cor": r.get("route_color", "1b6354")
            }

        route_ids = set(linhas_map.keys())
        print(f"[+] Rotas selecionadas: {len(route_ids)}")

        print("[+] Lendo trips.txt...")
        trips_reader = csv.DictReader(io.StringIO(z.read("trips.txt").decode("utf-8")))
        
        # Para cada route_id, escolhe a trip mais representativa para ida (0) e volta (1)
        trip_por_rota = {} # (route_id, direction_id) -> {trip_id, shape_id, trip_headsign}
        trip_ids_relevantes = set()
        shapes_relevantes = set()

        for t in trips_reader:
            rid = t.get("route_id")
            if rid not in route_ids:
                continue
            direction = str(t.get("direction_id", "0")).strip()
            key = (rid, direction)
            shape_id = t.get("shape_id")
            if shape_id and key not in trip_por_rota:
                trip_por_rota[key] = {
                    "trip_id": t["trip_id"],
                    "shape_id": shape_id,
                    "headsign": t.get("trip_headsign", "")
                }
                trip_ids_relevantes.add(t["trip_id"])
                shapes_relevantes.add(shape_id)

        print(f"[+] Viagens selecionadas: {len(trip_por_rota)}, shapes necessários: {len(shapes_relevantes)}")

        print("[+] Lendo shapes.txt...")
        shapes_pontos = {} # shape_id -> list of (seq, lat, lng)
        shapes_reader = csv.DictReader(io.StringIO(z.read("shapes.txt").decode("utf-8")))
        for s in shapes_reader:
            sid = s.get("shape_id")
            if sid not in shapes_relevantes:
                continue
            if sid not in shapes_pontos:
                shapes_pontos[sid] = []
            shapes_pontos[sid].append((
                int(s.get("shape_pt_sequence", 0)),
                float(s["shape_pt_lat"]),
                float(s["shape_pt_lon"])
            ))

        # Ordena shapes
        for sid in shapes_pontos:
            shapes_pontos[sid].sort(key=lambda x: x[0])
            shapes_pontos[sid] = [[p[1], p[2]] for p in shapes_pontos[sid]]

        print("[+] Lendo stop_times.txt...")
        trip_stops = {} # trip_id -> list of (seq, stop_id)
        stop_times_reader = csv.DictReader(io.StringIO(z.read("stop_times.txt").decode("utf-8")))
        stop_ids_necessarios = set()
        for st in stop_times_reader:
            tid = st.get("trip_id")
            if tid not in trip_ids_relevantes:
                continue
            if tid not in trip_stops:
                trip_stops[tid] = []
            sid = st.get("stop_id")
            trip_stops[tid].append((int(st.get("stop_sequence", 0)), sid))
            stop_ids_necessarios.add(sid)

        print(f"[+] Lendo stops.txt ({len(stop_ids_necessarios)} paradas necessárias)...")
        stops_info = {}
        stops_reader = csv.DictReader(io.StringIO(z.read("stops.txt").decode("utf-8")))
        for sp in stops_reader:
            sid = sp.get("stop_id")
            if sid in stop_ids_necessarios:
                stops_info[sid] = {
                    "id": sid,
                    "nome": sp.get("stop_name", "Ponto"),
                    "lat": round(float(sp["stop_lat"]), 6),
                    "lng": round(float(sp["stop_lon"]), 6)
                }

        # Constrói o JSON final para cada linha
        total_salvo = 0
        for rid, meta in linhas_map.items():
            linha = meta["linha"]
            dados_linha = {
                "linha": linha,
                "nome": meta["nome"],
                "ida": None,
                "volta": None
            }

            for direction, label in [("0", "ida"), ("1", "volta")]:
                key = (rid, direction)
                if key not in trip_por_rota:
                    continue
                info_trip = trip_por_rota[key]
                sid = info_trip["shape_id"]
                tid = info_trip["trip_id"]

                pontos_shape = shapes_pontos.get(sid, [])
                if pontos_shape:
                    pontos_shape = simplificar_trajeto(pontos_shape, tolerancia=0.00004)

                # Paradas ordenadas
                paradas_seq = trip_stops.get(tid, [])
                paradas_seq.sort(key=lambda x: x[0])
                paradas = []
                for _, stop_id in paradas_seq:
                    if stop_id in stops_info:
                        paradas.append(stops_info[stop_id])

                dados_linha[label] = {
                    "destino": info_trip["headsign"] or ("Ida" if direction == "0" else "Volta"),
                    "shape": [[round(p[0], 6), round(p[1], 6)] for p in pontos_shape],
                    "stops": paradas
                }

            # Salva o arquivo JSON da linha
            caminho_arquivo = os.path.join(OUTPUT_DIR, f"{linha}.json")
            with open(caminho_arquivo, "w", encoding="utf-8") as f:
                json.dump(dados_linha, f, ensure_ascii=False, separators=(',', ':'))

            total_salvo += 1
            kb = os.path.getsize(caminho_arquivo) / 1024
            print(f"[OK] Linha {linha} ({meta['nome']}): salvo em {caminho_arquivo} ({kb:.1f} KB)")

        print(f"\n[Sucesso!] {total_salvo} linhas extraídas com sucesso para '{OUTPUT_DIR}/'.")

if __name__ == "__main__":
    # Linhas prioritárias da cidade + as sugeridas na interface
    linhas_iniciais = [
        "232", "606", "693", "2345", "483", "371", "812", "100", "108", "309", "315", "415", "426", "432", "457", "474", "550", "639", "864", "918"
    ]
    if len(sys.argv) > 1:
        linhas_iniciais = sys.argv[1:]

    extrair_linhas(linhas_iniciais)
