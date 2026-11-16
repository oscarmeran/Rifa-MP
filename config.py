# =====================================================================
#   CONFIGURACIÓN DE LA RIFA
# ---------------------------------------------------------------------
#   Cambia los valores de abajo y guarda el archivo.
#   No hace falta reiniciar el servidor: basta con recargar la página
#   del navegador (F5) y los cambios se aplican solos.
# =====================================================================


# >>> CANTIDAD EXACTA DE REGALOS QUE SE VAN A RIFAR <<<
#     Los regalos se numeran del 1 hasta este número.
#     Ejemplo: 25  ->  regalos N.º 1, 2, 3, ... 25
CANTIDAD_REGALOS = 80


# >>> CANTIDAD EXACTA DE JUGUETES QUE SE VAN A RIFAR <<<
#     Los juguetes se numeran del 1 hasta este número.
#     En cada giro sale 1 participante + 1 regalo + 1 juguete.
#     Si una de las dos cantidades es mayor, cuando se acabe la otra se
#     sigue rifando solo lo que quede (la ruleta vacía muestra "—").
#     Pon 0 si no habrá juguetes.
CANTIDAD_JUGUETES = 37


# Título grande que aparece en la pantalla
TITULO_RIFA = "Gran Rifa de Regalos"

# Archivo con los nombres y apellidos de los participantes
ARCHIVO_PARTICIPANTES = "participantes.json"

# Archivo de la base de datos SQLite (se crea automáticamente)
ARCHIVO_BD = "rifa.db"

# Para hacer PRUEBAS: con True, cada vez que abras el programa la base de
# datos se borra y la rifa empieza en blanco.
# >>> El día del evento déjalo en False para no perder a los ganadores. <<<
REINICIAR_AL_INICIAR = False

# Servidor local (normalmente no hay que tocar esto)
import os
HOST = "0.0.0.0"
PUERTO = int(os.environ.get("PORT", 8000))
ABRIR_NAVEGADOR = False
