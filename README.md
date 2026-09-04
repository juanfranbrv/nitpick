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

Sobre la captura puedes **dibujar** antes de guardarla, con cuatro herramientas en la
barra del compositor:

| Herramienta | Para qué |
| --- | --- |
| ✎ Rotulador | Trazo libre |
| ↗ Flecha | Señalar un control concreto |
| ▭ Recuadro | Encerrar una zona |
| ▒ Difuminar | Tapar claves, tokens o datos de clientes antes de compartir |

Color y grosor se recuerdan entre capturas. `Ctrl` + `Z` deshace el último trazo. Todo
se quema en el PNG, así que el agente ve exactamente lo que le has señalado.

Si lo que falla es la **relación entre dos zonas alejadas**, no hace falta encuadrarlas:
pulsa `Enter` (o «toda la pantalla» en el aviso de arriba) y anotas sobre la pantalla
completa congelada.

Cada captura guarda además el **título y el tamaño de la ventana** que tenías delante,
que es la mitad de un informe de fallo y no hay que teclearla.

El portapapeles de Windows solo admite **un** elemento — o texto, o una imagen — así
que no hay forma de pegar varias capturas de una vez. Por eso el texto lleva las
rutas: es lo único que cabe en una pegada y sigue dando al agente acceso a todas las
imágenes. La primera vez el agente te pedirá permiso para leer fuera de su
directorio de trabajo.

Para notas sin captura, la caja del pie admite varias líneas: `Ctrl` + `Enter` o el
botón `⏎` la añaden a la lista. Y `Ctrl` + `V` con una imagen en el portapapeles la
convierte en una anotación, para capturas hechas con `Win` + `Shift` + `S` o que te
haya mandado otra persona.

## Ordenar, priorizar y copiar solo una parte

- Arrastra una nota **por su número** para reordenarla: el orden en que ves las cosas
  no es el orden en que quieres que se arreglen.
- El chip de cada nota cicla su **prioridad**: normal → bloqueante → menor. La
  prioridad viaja en el texto copiado, así que el agente sabe por dónde empezar.
- Las **casillas** limitan la copia: con tres marcadas, el botón pasa a «Copiar 3».
  Sin ninguna marcada copia todo.

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

Engranaje del panel: tema (oscuro / claro / según Windows), opacidad de la ventana,
**plantilla de salida** y si el panel queda fuera de las capturas.

Esa última merece explicación: activada (por defecto), Windows deja el panel fuera de
**toda** captura de pantalla, no solo de las nuestras — también de OBS, Teams,
`Win`+`Shift`+`S` y cualquier grabación. A cambio, la captura propia es unos 70 ms más
rápida y el panel no parpadea. Desactívala si alguna vez necesitas que el panel salga
en una grabación o una demo. El tamaño del panel se recuerda solo — lo estiras, y ahí se
queda entre colapsos y entre ejecuciones. Todo vive en `settings.json`.

La plantilla envuelve el texto copiado, porque Claude Code, Codex y OpenCode no
responden igual al mismo preámbulo. `{{notas}}` es el listado, `{{total}}` y
`{{fecha}}` son opcionales; si te dejas `{{notas}}` fuera, las notas se añaden al
final en lugar de perderse.

La plantilla **no** afecta a las notas guardadas: el archivo se escribe siempre en el
formato canónico, o cambiarla dejaría ilegibles las notas ya guardadas.

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
| `Ctrl` + `V` | Pegar una imagen del portapapeles como anotación |
| `Enter` | En el selector: anotar sobre la pantalla completa |
| `Ctrl` + `Z` | Deshacer el último trazo |
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

Cuatro decisiones sostienen la latencia entre pulsar el atajo y ver el selector
(769 ms al principio, 145 ms tras las tres primeras):

- La captura **no pasa por disco**. Vive en memoria y llega al webview por un
  esquema URI propio (`frozen://`) como **BMP**, que es prácticamente una copia de
  memoria. Comprimir un PNG del escritorio entero y volver a leerlo costaba cientos
  de milisegundos.
- La ventana de selección se **construye una sola vez** al arrancar y se reutiliza
  oculta. Crear un webview por captura costaba la otra mitad del retardo.
- Solo el recorte final se escribe a disco, ya como PNG.
- El panel **no se oculta**: se le pide a Windows que lo excluya de las capturas
  (`SetWindowDisplayAffinity`). Ocultarlo obligaba a esperar ~70 ms a que el
  compositor repintase — la mitad de lo que quedaba — y hacía parpadear el panel en
  cada atajo. Si la API falla, o si desactivas la opción, se vuelve al camino de
  ocultar y esperar.

Un detalle que costó dos intentos: optimizar solo las dependencias (`profile.dev.package."*"`)
no bastaba, porque el bucle de composición vive en *este* crate. Con `profile.dev`
también optimizado, componer dos monitores pasó de 133 ms a 1 ms.

La selección viaja al backend como **fracciones** de la imagen (0..1), no como
píxeles, de modo que el escalado de pantalla nunca entra en la aritmética del
recorte.

El difuminado no pinta píxeles opacos encima: vuelve a dibujar la propia captura
sobre sí misma a través de un filtro CSS, recortando el resultado al rectángulo. Sin
ese recorte el filtro muestrearía más allá del borde y dejaría un halo suave en vez
de un parche de bordes limpios.

## Limitaciones conocidas

- Con dos monitores a **escalados de DPI distintos**, la composición del escritorio
  virtual puede desalinearse. Con escalado uniforme funciona bien.
- El contexto que se guarda es el **título** de la ventana y su tamaño, **no la URL**.
  Sacar la dirección de un navegador exige recorrer su árbol de accesibilidad con UI
  Automation buscando la barra de direcciones: depende del navegador y falla en
  silencio cuando cambia. El título más el tamaño es lo que se puede obtener de forma
  fiable.
