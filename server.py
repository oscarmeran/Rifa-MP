"""
Servidor de la Rifa
===================

Ejecutar:   python server.py      (o doble clic en INICIAR_RIFA.bat)

Solo usa la librería estándar de Python: no hay que instalar nada.
La información se guarda en una base de datos SQLite (rifa.db).
"""

from __future__ import annotations

import importlib
import json
import secrets
import socket
import sqlite3
import sys
import threading
import webbrowser
from contextlib import closing
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import config

try:  # evita errores al imprimir acentos en consolas antiguas de Windows
    sys.stdout.reconfigure(errors="replace")
except Exception:
    pass

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
RUTA_CONFIG = BASE / "config.py"

azar = secrets.SystemRandom()          # aleatoriedad criptográfica: sorteo justo
candado = threading.RLock()            # un sorteo a la vez
avisos: dict[str, list[str]] = {"config": [], "json": []}
_firmas: dict[str, tuple | None] = {"config": None, "json": None}

ESQUEMA = """
CREATE TABLE IF NOT EXISTS participantes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre      TEXT    NOT NULL,
    apellido    TEXT    NOT NULL DEFAULT '',
    activo      INTEGER NOT NULL DEFAULT 1,   -- 1 = está en participantes.json
    disponible  INTEGER NOT NULL DEFAULT 1,   -- 1 = todavía no ha ganado en esta ronda
    UNIQUE (nombre, apellido)
);
CREATE TABLE IF NOT EXISTS regalos (
    numero      INTEGER PRIMARY KEY,
    entregado   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS juguetes (
    numero      INTEGER PRIMARY KEY,
    entregado   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sorteos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    participante_id INTEGER NOT NULL REFERENCES participantes(id),
    regalo_numero   INTEGER REFERENCES regalos(numero),    -- NULL = ya no quedaban regalos
    juguete_numero  INTEGER REFERENCES juguetes(numero),   -- NULL = ya no quedaban juguetes
    ronda           INTEGER NOT NULL,
    fecha           TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
);
"""

TIPOS = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".woff2": "font/woff2",
}


# ---------------------------------------------------------------------
#  Base de datos
# ---------------------------------------------------------------------
def ruta_bd() -> Path:
    return BASE / config.ARCHIVO_BD


def _abrir() -> sqlite3.Connection:
    con = sqlite3.connect(ruta_bd(), timeout=10)
    try:
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys = ON")
        con.executescript(ESQUEMA)  # crea las tablas si faltan (BD nueva, vacía o borrada)
        migrar(con)
        if not con.execute("SELECT 1 FROM meta WHERE clave = 'ronda'").fetchone():
            with con:
                guardar_ronda(con, 1)
            # BD recién creada: hay que volver a cargar regalos y participantes
            _firmas["config"] = _firmas["json"] = None
        return con
    except Exception:
        con.close()  # en Windows no se puede mover un archivo que sigue abierto
        raise


def migrar(con) -> None:
    """Actualiza una BD de la versión anterior (sin juguetes) sin perder los ganadores."""
    columnas = {r["name"] for r in con.execute("PRAGMA table_info(sorteos)")}
    if "juguete_numero" in columnas:
        return
    con.executescript(
        """
        CREATE TABLE sorteos_nueva (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            participante_id INTEGER NOT NULL REFERENCES participantes(id),
            regalo_numero   INTEGER REFERENCES regalos(numero),
            juguete_numero  INTEGER REFERENCES juguetes(numero),
            ronda           INTEGER NOT NULL,
            fecha           TEXT    NOT NULL
        );
        INSERT INTO sorteos_nueva (id, participante_id, regalo_numero, ronda, fecha)
            SELECT id, participante_id, regalo_numero, ronda, fecha FROM sorteos;
        DROP TABLE sorteos;
        ALTER TABLE sorteos_nueva RENAME TO sorteos;
        """
    )
    print("  >> Base de datos actualizada para incluir juguetes.")


def conectar() -> sqlite3.Connection:
    """Abre la BD. Si el archivo está dañado, lo aparta y crea uno nuevo."""
    try:
        return _abrir()
    except sqlite3.DatabaseError as e:
        if isinstance(e, sqlite3.OperationalError) and "locked" in str(e).lower():
            raise
        danada = ruta_bd().with_name(f"{ruta_bd().name}.danada-{datetime.now():%Y%m%d-%H%M%S}")
        ruta_bd().replace(danada)
        print(f"  [aviso] La base de datos estaba dañada ({e}). Se guardó como {danada.name} y se creó una nueva.")
        return _abrir()


def borrar_bd() -> bool:
    """Elimina el archivo de la BD (y sus temporales) para empezar desde cero."""
    try:
        for sufijo in ("", "-journal", "-wal", "-shm"):
            ruta = ruta_bd().with_name(ruta_bd().name + sufijo)
            if ruta.exists():
                ruta.unlink()
        _firmas["config"] = _firmas["json"] = None
        return True
    except PermissionError:
        print("\n  No se pudo borrar la base de datos: está abierta en otro programa.")
        print("  Cierra la otra ventana de la rifa y vuelve a intentarlo.\n")
        return False


def obtener_ronda(con) -> int:
    fila = con.execute("SELECT valor FROM meta WHERE clave = 'ronda'").fetchone()
    return int(fila["valor"]) if fila else 1


def guardar_ronda(con, ronda: int) -> None:
    con.execute(
        "INSERT INTO meta(clave, valor) VALUES ('ronda', ?) "
        "ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor",
        (str(ronda),),
    )


# ---------------------------------------------------------------------
#  Sincronización con participantes.json y config.py
# ---------------------------------------------------------------------
def limpiar(texto) -> str:
    return " ".join(str(texto or "").split())


def leer_participantes() -> tuple[list[tuple[str, str]], list[str]]:
    ruta = BASE / config.ARCHIVO_PARTICIPANTES
    if not ruta.exists():
        raise ValueError(f"No se encontró el archivo {ruta.name}.")
    try:
        datos = json.loads(ruta.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as e:
        raise ValueError(
            f"{ruta.name} tiene un error de formato en la línea {e.lineno}, "
            f"columna {e.colno} ({e.msg})."
        ) from None
    except UnicodeDecodeError:
        raise ValueError(f"{ruta.name} debe guardarse con codificación UTF-8.") from None

    lista = datos.get("participantes") if isinstance(datos, dict) else datos
    if not isinstance(lista, list):
        raise ValueError(f'{ruta.name} debe tener una lista llamada "participantes".')

    vistos: set[tuple[str, str]] = set()
    resultado: list[tuple[str, str]] = []
    problemas: list[str] = []
    for i, p in enumerate(lista, 1):
        if not isinstance(p, dict):
            problemas.append(f"Participante #{i} ignorado: formato inválido.")
            continue
        nombre, apellido = limpiar(p.get("nombre")), limpiar(p.get("apellido"))
        if not nombre:
            problemas.append(f"Participante #{i} ignorado: no tiene nombre.")
            continue
        clave = (nombre.casefold(), apellido.casefold())
        if clave in vistos:
            problemas.append(f"Nombre repetido ignorado: {nombre} {apellido}.")
            continue
        vistos.add(clave)
        resultado.append((nombre, apellido))
    return resultado, problemas


def sincronizar_premios(con, tabla: str, variable: str, nombre: str) -> None:
    """Deja en la tabla los números 1..N según config.py (regalos o juguetes)."""
    n = getattr(config, variable, 0)
    if not isinstance(n, int) or isinstance(n, bool) or n < 0:
        avisos["config"].append(f"{variable} en config.py debe ser un número entero (0 o más).")
        return
    with con:
        con.executemany(f"INSERT OR IGNORE INTO {tabla}(numero) VALUES (?)", [(i,) for i in range(1, n + 1)])
        con.execute(f"DELETE FROM {tabla} WHERE numero > ? AND entregado = 0", (n,))
    extra = con.execute(f"SELECT COUNT(*) FROM {tabla} WHERE numero > ?", (n,)).fetchone()[0]
    if extra:
        avisos["config"].append(
            f"Bajaste {variable} a {n}, pero ya se entregaron {extra} {nombre}(s) con número mayor."
        )


def sincronizar_regalos(con) -> None:
    sincronizar_premios(con, "regalos", "CANTIDAD_REGALOS", "regalo")
    sincronizar_premios(con, "juguetes", "CANTIDAD_JUGUETES", "juguete")
    if not getattr(config, "CANTIDAD_REGALOS", 0) and not getattr(config, "CANTIDAD_JUGUETES", 0):
        avisos["config"].append("En config.py, CANTIDAD_REGALOS y CANTIDAD_JUGUETES están en 0.")


def sincronizar_participantes(con) -> None:
    try:
        lista, problemas = leer_participantes()
    except ValueError as e:
        avisos["json"] = [f"{e} Se mantiene la lista anterior."]
        return
    avisos["json"] = problemas
    with con:
        con.execute("UPDATE participantes SET activo = 0")
        for nombre, apellido in lista:
            con.execute("INSERT OR IGNORE INTO participantes(nombre, apellido) VALUES (?, ?)", (nombre, apellido))
            con.execute("UPDATE participantes SET activo = 1 WHERE nombre = ? AND apellido = ?", (nombre, apellido))
    if not lista:
        avisos["json"].append(f"{config.ARCHIVO_PARTICIPANTES} no tiene participantes.")


def firma(ruta: Path):
    try:
        st = ruta.stat()
        return (st.st_mtime_ns, st.st_size)
    except FileNotFoundError:
        return None


def sincronizar(con, forzar: bool = False) -> None:
    """Relee config.py y participantes.json solo si cambiaron."""
    f_cfg = firma(RUTA_CONFIG)
    if forzar or f_cfg != _firmas["config"]:
        avisos["config"] = []
        if _firmas["config"] is not None:
            try:
                importlib.reload(config)
            except Exception as e:  # error de sintaxis en config.py
                avisos["config"].append(f"config.py tiene un error y no se pudo recargar: {e}")
        _firmas["config"] = f_cfg
        sincronizar_regalos(con)
        _firmas["json"] = None  # el nombre del archivo pudo cambiar

    f_json = firma(BASE / config.ARCHIVO_PARTICIPANTES)
    if forzar or f_json != _firmas["json"] or _firmas["json"] is None:
        _firmas["json"] = f_json
        sincronizar_participantes(con)


# ---------------------------------------------------------------------
#  Lógica de la rifa
# ---------------------------------------------------------------------
def numeros_libres(con, tabla: str) -> list[int]:
    return [r[0] for r in con.execute(f"SELECT numero FROM {tabla} WHERE entregado = 0 ORDER BY numero")]


def estado(con) -> dict:
    total_regalos = con.execute("SELECT COUNT(*) FROM regalos").fetchone()[0]
    total_juguetes = con.execute("SELECT COUNT(*) FROM juguetes").fetchone()[0]
    regalos_libres = numeros_libres(con, "regalos")
    juguetes_libres = numeros_libres(con, "juguetes")
    activos = con.execute(
        "SELECT nombre, apellido, disponible FROM participantes WHERE activo = 1 ORDER BY id"
    ).fetchall()
    disponibles = sum(r["disponible"] for r in activos)
    historial = [
        dict(r)
        for r in con.execute(
            """SELECT s.id, p.nombre, p.apellido, s.regalo_numero AS regalo, s.juguete_numero AS juguete,
                      s.ronda, s.fecha
               FROM sorteos s JOIN participantes p ON p.id = s.participante_id
               ORDER BY s.id DESC"""
        )
    ]
    quedan_premios = len(regalos_libres) + len(juguetes_libres) > 0
    return {
        "titulo": getattr(config, "TITULO_RIFA", "Gran Rifa"),
        "total_regalos": total_regalos,
        "regalos_restantes": len(regalos_libres),
        "regalos_disponibles": regalos_libres,
        "total_juguetes": total_juguetes,
        "juguetes_restantes": len(juguetes_libres),
        "juguetes_disponibles": juguetes_libres,
        "participantes_total": len(activos),
        "participantes_disponibles": disponibles,
        "nombres": [{"nombre": r["nombre"], "apellido": r["apellido"], "d": bool(r["disponible"])} for r in activos],
        "ronda": obtener_ronda(con),
        "historial": historial,
        "terminado": total_regalos + total_juguetes > 0 and not quedan_premios,
        "sin_participantes": len(activos) == 0,
        "sin_nombres": quedan_premios and len(activos) > 0 and disponibles == 0,
        "avisos": avisos["config"] + avisos["json"],
    }


def sortear(con):
    """En cada giro sale 1 participante + 1 regalo + 1 juguete.
    Si ya no quedan regalos (o juguetes), esa parte queda vacía y se sigue
    rifando lo que quede, hasta que se acaben ambos."""
    regalos = numeros_libres(con, "regalos")
    juguetes = numeros_libres(con, "juguetes")
    if not regalos and not juguetes:
        return 409, {"codigo": "RIFA_TERMINADA", "mensaje": "Ya se entregaron todos los regalos y juguetes.", "estado": estado(con)}
    personas = con.execute(
        "SELECT id, nombre, apellido FROM participantes WHERE activo = 1 AND disponible = 1"
    ).fetchall()
    if not personas:
        return 409, {
            "codigo": "SIN_NOMBRES",
            "mensaje": "Ya no quedan nombres disponibles. Reestablece los nombres para continuar.",
            "estado": estado(con),
        }

    persona = azar.choice(personas)
    regalo = azar.choice(regalos) if regalos else None
    juguete = azar.choice(juguetes) if juguetes else None
    ronda = obtener_ronda(con)
    with con:
        con.execute("UPDATE participantes SET disponible = 0 WHERE id = ?", (persona["id"],))
        if regalo is not None:
            con.execute("UPDATE regalos SET entregado = 1 WHERE numero = ?", (regalo,))
        if juguete is not None:
            con.execute("UPDATE juguetes SET entregado = 1 WHERE numero = ?", (juguete,))
        con.execute(
            "INSERT INTO sorteos(participante_id, regalo_numero, juguete_numero, ronda, fecha) VALUES (?, ?, ?, ?, ?)",
            (persona["id"], regalo, juguete, ronda, datetime.now().isoformat(timespec="seconds")),
        )
    r_txt = f"Regalo N.º {regalo}" if regalo is not None else "sin regalo"
    j_txt = f"Juguete N.º {juguete}" if juguete is not None else "sin juguete"
    print(f"  {persona['nombre']} {persona['apellido']}  ->  {r_txt} + {j_txt}  (ronda {ronda})")
    return 200, {
        "ganador": {"nombre": persona["nombre"], "apellido": persona["apellido"]},
        "regalo": regalo,
        "juguete": juguete,
        "ronda": ronda,
        "estado": estado(con),
    }


def reestablecer_nombres(con):
    st = estado(con)
    if st["regalos_restantes"] + st["juguetes_restantes"] == 0:
        return 409, {"codigo": "RIFA_TERMINADA", "mensaje": "Ya se entregaron todos los regalos y juguetes.", "estado": st}
    if st["participantes_disponibles"] > 0:
        return 409, {
            "codigo": "AUN_HAY_NOMBRES",
            "mensaje": f"Todavía quedan {st['participantes_disponibles']} participante(s) sin regalo.",
            "estado": st,
        }
    nueva = obtener_ronda(con) + 1
    with con:
        con.execute("UPDATE participantes SET disponible = 1")
        guardar_ronda(con, nueva)
    print(f"  >> Nombres reestablecidos. Comienza la ronda {nueva}.")
    return 200, {"ronda": nueva, "estado": estado(con)}


def reiniciar(con):
    """Borra y vuelve a crear todas las tablas (también arregla BD de versiones viejas)."""
    con.executescript(
        "DROP TABLE IF EXISTS sorteos; DROP TABLE IF EXISTS participantes;"
        "DROP TABLE IF EXISTS regalos; DROP TABLE IF EXISTS juguetes; DROP TABLE IF EXISTS meta;" + ESQUEMA
    )
    with con:
        guardar_ronda(con, 1)
    sincronizar(con, forzar=True)
    print("  >> Rifa reiniciada desde cero.")
    return 200, {"estado": estado(con)}


# ---------------------------------------------------------------------
#  Servidor HTTP
# ---------------------------------------------------------------------
class Manejador(BaseHTTPRequestHandler):
    server_version = "Rifa/1.0"

    def log_message(self, *args):  # silencio en la consola
        pass

    def _enviar(self, codigo: int, cuerpo: bytes, tipo: str, extra: dict | None = None):
        self.send_response(codigo)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(cuerpo)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(cuerpo)

    def _json(self, codigo: int, datos: dict):
        self._enviar(codigo, json.dumps(datos, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _con_bd(self, accion):
        try:
            with candado, closing(conectar()) as con:
                sincronizar(con)
                return accion(con)
        except Exception as e:  # nunca dejar al navegador sin respuesta
            print(f"  [error] {e!r}")
            return 500, {"codigo": "ERROR", "mensaje": f"Error interno del servidor: {e}"}

    def do_GET(self):
        ruta = unquote(urlparse(self.path).path)
        if ruta == "/api/estado":
            self._json(*self._con_bd(lambda con: (200, estado(con))))
        else:
            self._estatico(ruta)

    def do_POST(self):
        largo = int(self.headers.get("Content-Length") or 0)
        if largo:
            self.rfile.read(largo)
        acciones = {
            "/api/sortear": sortear,
            "/api/reestablecer-nombres": reestablecer_nombres,
            "/api/reiniciar": reiniciar,
        }
        accion = acciones.get(urlparse(self.path).path)
        if not accion:
            self._json(404, {"codigo": "NO_ENCONTRADO", "mensaje": "Ruta desconocida."})
            return
        self._json(*self._con_bd(accion))

    def _estatico(self, ruta: str):
        if ruta in ("", "/"):
            ruta = "/index.html"
        archivo = (STATIC / ruta.lstrip("/")).resolve()
        if not archivo.is_relative_to(STATIC) or not archivo.is_file():
            self._enviar(404, b"No encontrado", "text/plain; charset=utf-8")
            return
        tipo = TIPOS.get(archivo.suffix.lower(), "application/octet-stream")
        self._enviar(200, archivo.read_bytes(), tipo)


class Servidor(ThreadingHTTPServer):
    daemon_threads = True
    # En Windows, SO_REUSEADDR permite "encimarse" sobre un puerto que ya usa otro
    # programa; se pide uso exclusivo para que falle con un mensaje claro.
    allow_reuse_address = sys.platform != "win32"

    def server_bind(self):
        if sys.platform == "win32" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main():
    anfitrion = "localhost" if config.HOST in ("127.0.0.1", "0.0.0.0") else config.HOST
    url = f"http://{anfitrion}:{config.PUERTO}"
    try:
        servidor = Servidor((config.HOST, config.PUERTO), Manejador)
    except OSError:
        print(f"\n  No se pudo usar el puerto {config.PUERTO}. ¿La rifa ya está abierta en otra ventana?")
        print("  Cierra la otra ventana o cambia PUERTO en config.py.\n")
        sys.exit(1)

    # Empezar con la base de datos en blanco:
    #   python server.py --reiniciar   (o REINICIAR_RIFA.bat)
    #   o REINICIAR_AL_INICIAR = True en config.py
    if "--reiniciar" in sys.argv or getattr(config, "REINICIAR_AL_INICIAR", False):
        if not borrar_bd():
            sys.exit(1)
        print("\n  >> Base de datos borrada: la rifa empieza desde cero.")

    with closing(conectar()) as con:
        sincronizar(con, forzar=True)
        st = estado(con)

    print("\n  ===============================================")
    print(f"     {st['titulo']}")
    print("  ===============================================")
    print(f"   Regalos:        {st['regalos_restantes']} por entregar de {st['total_regalos']}")
    print(f"   Juguetes:       {st['juguetes_restantes']} por entregar de {st['total_juguetes']}")
    print(f"   Participantes:  {st['participantes_disponibles']} disponibles de {st['participantes_total']}")
    print(f"   Ronda:          {st['ronda']}")
    for a in st["avisos"]:
        print(f"   [aviso] {a}")
    print(f"\n   Abre en el navegador:  {url}")
    print("   Para detener la rifa:  Ctrl + C\n")

    if config.ABRIR_NAVEGADOR:
        threading.Timer(0.8, webbrowser.open, args=(url,)).start()
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print("\n  Rifa detenida. Los resultados quedan guardados en", config.ARCHIVO_BD)


if __name__ == "__main__":
    main()
