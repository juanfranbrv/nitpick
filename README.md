# Anotador

Panel flotante siempre por encima de las demás ventanas para apuntar lo que ves mal
mientras miras el servidor de desarrollo, y volcarlo todo de una vez en el chat de
un agente local.

## Cómo se usa

1. `Ctrl` + `Alt` + `A` — la pantalla se congela, arrastras un rectángulo sobre lo
   que está mal y escribes la nota ahí mismo. `Ctrl` + `Enter` la guarda y vuelves a
   lo que estabas haciendo. `Esc` cancela.
2. Repite tantas veces como haga falta. El panel solo lleva la cuenta.
3. **Copiar todo** (o `Ctrl` + `Alt` + `C`) deja en el portapapeles un texto como este:

   ```
   # Anotaciones (2) - 2026-09-03 12:40

   ## 1
   El sidebar se solapa con el header por debajo de 900px.
   Captura: C:\Users\Usuario\Anotador\capturas\20260903-1204\01.png

   ## 2
   El botón de submit no muestra estado de carga.
   Captura: C:\Users\Usuario\Anotador\capturas\20260903-1204\02.png
   ```

4. Lo pegas en Claude Code, Codex u OpenCode y el agente abre las capturas solo.

Sobre la captura puedes **dibujar con el rotulador** antes de guardarla: eliges color
y grosor en la barra del compositor, `Ctrl` + `Z` deshace el último trazo. Los trazos
se queman en el PNG, así que el agente ve lo que le has señalado.

El portapapeles de Windows solo admite **un** elemento — o texto, o una imagen — así
que no hay forma de pegar varias capturas de una vez. Por eso el texto lleva las
rutas: es lo único que cabe en una pegada y sigue dando al agente acceso a todas las
imágenes. La primera vez el agente te pedirá permiso para leer fuera de su
directorio de trabajo.

Para notas sin captura, la caja del pie admite varias líneas: `Ctrl` + `Enter` o el
botón `⏎` la añaden a la lista.

## Guardar, abrir y vaciar notas

- **Guardar notas** escribe la lista completa en `guardadas\<sesión>.md`, deja las
  capturas donde están y empieza una lista nueva. Nada se pierde.
- El botón de la cabecera abre la lista de **notas guardadas**: pulsa una y vuelve
  a cargarse en el panel, con sus capturas. Si la lista actual no está vacía se
  guarda antes, previa confirmación, de modo que abrir nunca pisa nada.
- **Vaciar** borra las notas y sus PNG. Pide confirmación.

El `.md` *es* el formato de archivo: no hay un JSON paralelo que se pueda
desincronizar, y una lista guardada se puede editar a mano en cualquier editor y seguirá
abriéndose. Un test de ida y vuelta (`cargo test`) protege esa propiedad.

## Ajustes

Engranaje del panel: tema (oscuro / claro / según Windows) y opacidad de la ventana.
El tamaño del panel se recuerda solo — lo estiras, y ahí se queda entre colapsos y
entre ejecuciones. Todo vive en `settings.json`.

## Dónde se guarda todo

```
C:\Users\<tú>\Anotador\
  session.json              lista de anotaciones en curso (sobrevive a reinicios)
  settings.json             ajustes
  capturas\<sesión>\NN.png  los recortes
  guardadas\<sesión>.md     listas archivadas con "Guardar notas"
```

## Atajos

| Atajo | Qué hace |
| --- | --- |
| `Ctrl` + `Alt` + `A` | Capturar región y anotar |
| `Ctrl` + `Alt` + `C` | Copiar todas las anotaciones |
| `Ctrl` + `Enter` | Guardar la nota que estás escribiendo |
| `Ctrl` + `Z` | Deshacer el último trazo del rotulador |
| `Esc` | Cancelar la captura |

Si otro programa ya usa uno de los atajos globales, Anotador arranca igual y te lo
avisa en el panel: pierdes el atajo, no la aplicación.

## Desarrollo

```bash
pnpm install
pnpm tauri dev
```

Para generar el instalador:

```bash
pnpm tauri build
```

## Cómo está montado

El selector de región no dibuja sobre una ventana transparente: primero captura
**todos** los monitores con `xcap` y los compone en una sola imagen con la
disposición del escritorio virtual (`src-tauri/src/capture.rs`), y esa imagen
congelada es el fondo de la ventana de selección. Así la pantalla no puede cambiar
mientras arrastras, una selección puede cruzar dos monitores, y no hay que pelearse
con la transparencia y el click-through de Windows.

Tres decisiones sostienen la latencia entre pulsar el atajo y ver el selector:

- La captura **no pasa por disco**. Vive en memoria y llega al webview por un
  esquema URI propio (`frozen://`) como **BMP**, que es prácticamente una copia de
  memoria. Comprimir un PNG del escritorio entero y volver a leerlo costaba cientos
  de milisegundos.
- La ventana de selección se **construye una sola vez** al arrancar y se reutiliza
  oculta. Crear un webview por captura costaba la otra mitad del retardo.
- Solo el recorte final se escribe a disco, ya como PNG.

La selección viaja al backend como **fracciones** de la imagen (0..1), no como
píxeles, de modo que el escalado de pantalla nunca entra en la aritmética del
recorte.

Limitación conocida: con dos monitores a escalados de DPI distintos, la composición
del escritorio virtual puede desalinearse. Con escalado uniforme funciona bien.
