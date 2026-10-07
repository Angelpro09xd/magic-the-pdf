# 🃏 Magic the PDF

Web app para construir mazos de **Commander** de Magic: The Gathering y exportarlos como **proxies en PDF**, con las cartas en el **idioma que elijas**. Cuando una carta no existe impresa en ese idioma, la **traduce un traductor propio** (sin claves ni configuración) que aprende de las cartas oficiales, y el texto se coloca sobre la carta original o en un marco propio. Incluye **editor completo de cartas** y **selector de artes**.

## Funciones

### Construcción del mazo
- **Búsqueda** con toda la sintaxis de Scryfall, autocompletado y filtros: identidad de color del comandante, tipo, CMC, color, económicas (< 1 $) y "existe en mi idioma" (muestra directamente las impresiones en ese idioma).
- **Comandantes**: compañeros (Partner, Partner with, Friends forever, Choose a Background, Doctor's companion…) y **comandante aleatorio**.
- **Validación** de las reglas de Commander: 100 cartas, singleton (respeta básicas y "any number of cards named"), identidad de color, cartas prohibidas, parejas de comandantes válidas, Game Changers y número de tierras.
- **Selector de artes** 🎨: todas las impresiones de cada carta con filtros por idioma, estilo (sin borde, showcase, arte extendido, arte completo, retro, grabado, promo), "una por ilustración" y orden por fecha o precio.
- **Varios artes por carta**: en las tierras básicas, elige varias ilustraciones (o al azar) y cada copia sale con una distinta.
- **Artes de todo el mazo** de una vez: las más recientes, las originales, las más baratas, las especiales o las de marco moderno.
- **Deshacer/rehacer** (Ctrl+Z / Ctrl+Y).
- Vista de **lista o imágenes**, agrupada por tipo, CMC, función o estado de idioma. Vista previa al pasar el ratón.
- **Varios mazos** guardados en el navegador: crear, renombrar, duplicar y borrar. Notas por mazo.

### Idioma y traducción
1. Para cada carta se busca una **impresión oficial** en el idioma del mazo (Scryfall, 11 idiomas: español, inglés, francés, alemán, italiano, portugués, japonés, coreano, ruso y chino simplificado/tradicional).
2. Si no existe, la traduce el **traductor propio**, que funciona sin configurar nada:
   - **Memoria de traducción**: al usar un idioma por primera vez, descarga de Scryfall unas 6.000 cartas oficiales de ese idioma (~1 minuto; luego queda guardada en `data/memory-<idioma>.json` durante 30 días) y aprende cómo traduce Wizards cada frase, línea de tipo y subtipo. Las plantillas se generalizan: lo aprendido de "{T}: Add {G}." sirve para "{T}: Add {R}.", y lo de "deals 2 damage" para "deals 3 damage".
   - **Traducción automática gratuita** (Google Translate público, con MyMemory de respaldo) solo para las frases que no estén en la memoria, protegiendo símbolos de maná y nombres, con correcciones de terminología.
   - **Nombres oficiales** de MTG.io cuando existen.
   - Opcional: si configuras `ANTHROPIC_API_KEY`, Claude traduce primero y el traductor propio queda de respaldo.
3. Cada carta muestra de dónde sale su texto: *Oficial*, *Plantilla oficial* (todo de cartas oficiales), *Traducida* (mezcla) o *Automática*.
4. Render de las cartas traducidas:
   - **Texto sobre la carta original**: se busca una impresión con marco moderno y se tapa el nombre, el tipo y el texto con el color de fondo de la carta.
   - **Marco propio**: carta dibujada desde cero con el arte, para marcos antiguos, sagas, planeswalkers, etc.

Las traducciones se guardan en caché en el servidor (`data/translations.json`).

### Editor de cartas ✏️
- Edita **todo**: nombre, coste de maná, línea de tipo, texto de reglas, texto de ambientación, fuerza/resistencia, lealtad, defensa e ilustrador, con una paleta de símbolos de maná.
- **Traduce la carta** a cualquiera de los 11 idiomas desde el propio editor (incluido el texto de ambientación), o vuelve al texto inglés u oficial.
- **Arte**: de cualquier edición de la carta, de **cualquier otra carta** (búsqueda), **subiendo una imagen** o por URL, con **zoom y encuadre**.
- **Aspecto**: marco propio o texto sobre la carta original, color del marco y tamaño de letra.
- Vista previa en vivo tal como se imprimirá, y descarga en **PNG**.
- **Cartas personalizadas** desde cero (✨ en la pestaña Buscar), que se añaden al mazo y se imprimen como las demás.

### Herramientas
- **Sugerencias de EDHREC** para tu comandante (% de inclusión y sinergia), añadiendo con un clic.
- **Combos** de Commander Spellbook: los que ya tiene el mazo y los que están a una carta.
- **Análisis**: curva de maná, tipos, símbolos frente a fuentes de maná, funciones (rampa, robo, removal, barridos, tutores, contrahechizos, protección) con rangos recomendados, precio en $ y €, **bracket estimado** y sugerencias.
- **Mano de prueba** con mulligan, robo y probabilidad de tierras.
- **Fichas y emblemas** que genera el mazo.

### Importar y exportar
- Importar texto (MTGO, Arena, Moxfield, Archidekt, TappedOut; sección `Commander` o marca `*CMDR*`).
- Importar desde URL: **Archidekt**, **MTGGoldfish**, **TappedOut** y **Moxfield** (Moxfield suele bloquear las peticiones automáticas; si falla, exporta la lista desde Moxfield y pégala).
- Exportar a MTGO/Moxfield, Arena, solo nombres, CSV y JSON (copia de seguridad restaurable).
- **Enlace para compartir** el mazo.

### PDF
- Papel A4, Letter o A3; cartas a 63 × 88 mm con **escala** ajustable.
- **Separación** entre cartas, **sangrado** negro y **marcas de corte**.
- **Página con la lista** del mazo (con el nombre traducido y el original), en cualquier alfabeto.
- Incluir u omitir comandantes, tierras básicas, fichas y cartas sueltas.
- **Doble cara**: el dorso de las cartas transformables detrás de la cara frontal (impresión a doble cara) y **reversos** genéricos o personalizados.
- Marca "PROXY" opcional, calidad alta (PNG) o normal (JPG).
- **Página de calibración** con un rectángulo de 63 × 88 mm y una regla para comprobar la escala de la impresora.
- **Elegir qué cartas imprimir** (todas, solo traducidas/editadas, solo oficiales o una a una).

## Versión web (GitHub Pages)

La app funciona **sin servidor**: se publica sola en GitHub Pages con el workflow `.github/workflows/pages.yml`.

- **Dirección**: `https://angelpro09xd.github.io/magic-the-pdf/`
- **Activarlo (una sola vez)**: en el repositorio, *Settings → Pages → Build and deployment → Source: **GitHub Actions***. Después cada push a la rama principal (o *Actions → Publicar en GitHub Pages → Run workflow*) publica la web.
- El workflow pasa los tests, genera `dist/` con `npm run build:pages` y **precalcula las memorias de traducción de los 10 idiomas** (`memory/<idioma>.json`), así el traductor funciona al instante en el navegador. Cada lunes se vuelven a generar para incluir las cartas oficiales nuevas.
- En la versión web todo se hace desde el navegador: Scryfall, imágenes, EDHREC, Commander Spellbook, Google Translate y MyMemory permiten peticiones directas. Los mazos y las traducciones se guardan en el navegador (localStorage e IndexedDB).
- **Diferencia con el servidor**: la importación desde URL (Archidekt, Moxfield…) solo funciona con el servidor, porque esas webs no permiten peticiones desde otras páginas. En la versión web, exporta la lista y pégala como texto. Claude (opcional) también requiere el servidor.

Probar la versión estática en local: `npm run preview:pages`.

## Puesta en marcha (con servidor, opcional)

Requisitos: Node.js 20 o superior.

```bash
npm install
npm start                # http://localhost:3000
```

No hace falta configurar nada. Opcionalmente, en un fichero `.env` (ver `.env.example`):

| Variable | Para qué |
|---|---|
| `MEMORY_WARMUP` | Idiomas cuya memoria se prepara al arrancar (por defecto `es`). |
| `MYMEMORY_EMAIL` | Sube el límite gratuito diario de MyMemory (respaldo de la traducción automática). |
| `ANTHROPIC_API_KEY` | Opcional: Claude traduce primero y el traductor propio queda de respaldo. |
| `ANTHROPIC_MODEL` / `ANTHROPIC_EFFORT` | Modelo (por defecto `claude-opus-5-5`) y esfuerzo de Claude. |
| `PORT` | Puerto del servidor (3000). |

Tests: `npm test`.

## Arquitectura

- `public/js/backend.js`: decide si hay servidor (`/api/…`) o si todo se hace desde el navegador (GitHub Pages).
- `public/js/translator/`: el traductor (memoria, traducción automática, motor y almacén), común al servidor y al navegador.
- `scripts/build-pages.js`: genera la web estática con las memorias precalculadas.
- `server/`: Express (opcional). Proxy de imágenes (para usarlas en `<canvas>` y en el PDF), EDHREC, Commander Spellbook, importadores por URL y el traductor:
  - `server/lib/memoryStore.js`: guarda en disco la memoria de cada idioma.
  - `server/lib/translate.js`: añade Claude al motor si hay clave.
- `public/`: frontend sin paso de compilación (módulos ES).
  - `js/scryfall.js`: cliente de Scryfall (respeta su límite de peticiones y agrupa búsquedas).
  - `js/deck.js`: lógica pura del mazo (parseo, validación, estadísticas), con tests.
  - `js/resolve.js`: decide, para cada carta, si se imprime la versión oficial o la traducida.
  - `js/render.js`: dibuja las cartas traducidas en canvas.
  - `js/pdf.js`: compone el PDF con jsPDF.
  - `js/editor.js`: editor completo de cartas.
  - `js/arts.js`: selector de artes.

## APIs utilizadas

| API | Uso |
|---|---|
| [Scryfall](https://scryfall.com/docs/api) | Búsqueda, cartas, impresiones por idioma, imágenes, rulings, símbolos, precios |
| Scryfall (cartas oficiales por idioma) | Memoria del traductor propio |
| Google Translate (endpoint público) | Traducción automática gratuita |
| [MyMemory](https://mymemory.translated.net/doc/spec.php) | Respaldo de la traducción automática |
| [MTG.io](https://docs.magicthegathering.io) | Nombres oficiales antiguos |
| [Claude (Anthropic)](https://docs.anthropic.com) | Opcional, si hay clave |
| [EDHREC](https://edhrec.com) | Recomendaciones por comandante |
| [Commander Spellbook](https://commanderspellbook.com) | Combos |
| Archidekt, Moxfield, MTGGoldfish, TappedOut | Importación de mazos |

## Aviso legal

Magic the PDF es contenido de fans no oficial permitido por la Política de contenido de fans de Wizards of the Coast; no está aprobado ni respaldado por Wizards. Magic: The Gathering y sus imágenes son propiedad de Wizards of the Coast. Los proxies son para jugar de forma casual: no los vendas.
