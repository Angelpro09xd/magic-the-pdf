# 🃏 Magic the PDF

Web app para construir mazos de **Commander** de Magic: The Gathering y exportarlos como **proxies en PDF**, con las cartas en el **idioma que elijas**. Cuando una carta no existe impresa en ese idioma, se **traduce con IA (Claude)** y el texto traducido se coloca sobre la carta original o en un marco propio.

## Funciones

### Construcción del mazo
- **Búsqueda** con toda la sintaxis de Scryfall, autocompletado y filtros: identidad de color del comandante, tipo, CMC, color, económicas (< 1 $) y "existe en mi idioma" (muestra directamente las impresiones en ese idioma).
- **Comandantes**: compañeros (Partner, Partner with, Friends forever, Choose a Background, Doctor's companion…) y **comandante aleatorio**.
- **Validación** de las reglas de Commander: 100 cartas, singleton (respeta básicas y "any number of cards named"), identidad de color, cartas prohibidas, parejas de comandantes válidas, Game Changers y número de tierras.
- **Ediciones e idiomas**: elige la impresión exacta de cada carta (cualquier edición e idioma), con precios.
- Vista de **lista o imágenes**, agrupada por tipo, CMC, función o estado de idioma. Vista previa al pasar el ratón.
- **Varios mazos** guardados en el navegador: crear, renombrar, duplicar y borrar. Notas por mazo.

### Idioma y traducción
1. Para cada carta se busca una **impresión oficial** en el idioma del mazo (Scryfall, 11 idiomas: español, inglés, francés, alemán, italiano, portugués, japonés, coreano, ruso y chino simplificado/tradicional).
2. Si no existe, se **traduce**, por este orden:
   - **IA (Claude)**: usa como referencia traducciones oficiales reales de ese idioma (sacadas de Scryfall) para respetar la terminología y la redacción de Wizards, y respeta los símbolos de maná `{T}`, `{G}`… Usa salida estructurada (JSON schema).
   - **Texto oficial de MTG.io** (cartas antiguas con traducción oficial).
   - **Traducción automática** (MyMemory) como último recurso, protegiendo los símbolos de maná.
3. Cada traducción se puede **revisar y editar a mano**, con vista previa. También se puede elegir idioma por carta o dejar alguna en inglés.
4. Render de las cartas traducidas:
   - **Texto sobre la carta original**: se busca una impresión inglesa con marco moderno y se tapa el nombre, el tipo y el texto con el color de fondo de la carta.
   - **Marco propio**: carta dibujada desde cero con el arte, para marcos antiguos, sagas, planeswalkers, etc.

Las traducciones se guardan en caché en el servidor (`data/translations.json`) para no pagar dos veces por la misma carta.

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

## Puesta en marcha

Requisitos: Node.js 20 o superior.

```bash
npm install
cp .env.example .env     # añade tu ANTHROPIC_API_KEY para la traducción por IA
npm start                # http://localhost:3000
```

Variables de entorno (`.env`):

| Variable | Para qué |
|---|---|
| `ANTHROPIC_API_KEY` | Activa la traducción con Claude. Sin ella, la app funciona igual con traducciones oficiales y automáticas. |
| `ANTHROPIC_MODEL` | Modelo de Claude (por defecto `claude-opus-5-5`). |
| `ANTHROPIC_EFFORT` | Nivel de esfuerzo (`low`, `medium`, `high`…). Por defecto `low`. |
| `MYMEMORY_EMAIL` | Opcional: sube el límite gratuito diario de MyMemory. |
| `PORT` | Puerto del servidor (3000). |

Tests: `npm test`.

## Arquitectura

- `server/`: Express. Proxy de imágenes (para usarlas en `<canvas>` y en el PDF), EDHREC, Commander Spellbook, importadores por URL y el traductor (`server/lib/translate.js`).
- `public/`: frontend sin paso de compilación (módulos ES).
  - `js/scryfall.js`: cliente de Scryfall (respeta su límite de peticiones y agrupa búsquedas).
  - `js/deck.js`: lógica pura del mazo (parseo, validación, estadísticas), con tests.
  - `js/resolve.js`: decide, para cada carta, si se imprime la versión oficial o la traducida.
  - `js/render.js`: dibuja las cartas traducidas en canvas.
  - `js/pdf.js`: compone el PDF con jsPDF.

## APIs utilizadas

| API | Uso |
|---|---|
| [Scryfall](https://scryfall.com/docs/api) | Búsqueda, cartas, impresiones por idioma, imágenes, rulings, símbolos, precios |
| [Claude (Anthropic)](https://docs.anthropic.com) | Traducción de cartas |
| [MTG.io](https://docs.magicthegathering.io) | Traducciones oficiales antiguas |
| [MyMemory](https://mymemory.translated.net/doc/spec.php) | Traducción automática de respaldo |
| [EDHREC](https://edhrec.com) | Recomendaciones por comandante |
| [Commander Spellbook](https://commanderspellbook.com) | Combos |
| Archidekt, Moxfield, MTGGoldfish, TappedOut | Importación de mazos |

## Aviso legal

Magic the PDF es contenido de fans no oficial permitido por la Política de contenido de fans de Wizards of the Coast; no está aprobado ni respaldado por Wizards. Magic: The Gathering y sus imágenes son propiedad de Wizards of the Coast. Los proxies son para jugar de forma casual: no los vendas.
