# ADR 0005 — Documentos de estudio y material imprimible

**Estado:** Aceptado (2026-10-05)

## Contexto

Hasta ahora todo el contenido eran ejercicios. Se piden además materiales para estudiar y para hacer pruebas en
papel: resúmenes, hojas de trucos, tarjetas, glosarios, ejemplos resueltos, esquemas, líneas del tiempo,
comprensión lectora, dictados y redacciones. Se pide también que los PDF cambien según la materia: en matemáticas,
hojas para hacer el ejercicio en la página y las soluciones al final. El niño tiene que poder leerlos en la app y
el tutor imprimirlos, en cinco materias (matemáticas, lengua, idiomas, ciencias naturales y ciencias sociales).

Restricciones que pesan:

- El Worker va en el plan gratuito: 10 ms de CPU por invocación. Generar PDF en el servidor no cabe.
- Los genera la skill `smartkids_content` (la escribe Claude, sin clave de API), igual que los ejercicios (ADR 0002).
- El contenido del tutor es privado de su hogar (ADR 0003), y a una solicitud se le puede pedir SOLO documentos.
- Ya existía la «Ficha PDF» con `window.print()`, que reutiliza `MathText`, las figuras y las cuentas en columna.

## Decisión

- **El documento es JSON por bloques, con un modelo único en `packages/shared`** (`studydoc.ts`, Zod), como el
  ejercicio (ADR 0001): 10 tipos de documento y 20 tipos de bloque. El mismo JSON se pinta en pantalla y en papel.
  No se usa Markdown ni HTML. Así el validador puede exigir lo que el papel necesita: preguntas con su respuesta,
  SVG seguro, límites y mínimos por tipo. Además, el texto del dictado puede quitarse antes de que llegue al niño.
- **Notación explícita:** `**negrita**` y matemáticas solo entre `$...$`. El resto del texto es plano, porque
  `MathText` aplicado a la prosa convierte «y/o» en una fracción y pone en cursiva la «I» inglesa. En los ejercicios
  impresos, la notación la decide la familia de la materia.
- **Una tabla propia, `study_docs`,** con el cuerpo en JSON (hasta 90 KB) y los enlaces opcionales a skill, path,
  curso y solicitud. No va colgada de los skills. Los documentos privados se asignan con `child_study_docs` y se
  revalida el hogar (la doble comprobación del ADR 0003). Los globales se ven por asignatura y nivel, como los
  cursos.
- **Versionado por contenido:** el import hace upsert por id y la versión solo sube si cambia el hash. `hidden` y
  `child_answers` son curación del tutor y republicar no los pisa (igual que `hidden` en las plantillas).
- **Un solo cierre de solicitud,** `closeRequest()`. Lo llaman el import de ejercicios (salvo `close:false`), el de
  documentos (`close:true`) y un `/close` manual. Cuenta lo vigente, anota lo que faltó y manda un único email.
- **El PDF lo hace el navegador** (`window.print()`), con un `@page` por trabajo y tokens de tinta. Las piezas del
  papel (cuadrícula, renglones, pautas, recuadros) se dibujan en CSS y SVG, en milímetros. Lo que depende de la
  materia y de la edad se concentra en un perfil puro (`print/profiles.ts`). La selección de preguntas, los puntos
  del examen y la versión B también son funciones puras, con pruebas.
- **El tutor puede leer los cursos globales en solo lectura,** y solo los de los cursos de su hogar, para poder
  imprimirlos. Antes recibía un 403.

## Consecuencias

- (+) Cero dependencias, cero CPU de servidor y PDF vectorial. Las fichas reutilizan lo que ya pinta la sesión
      (cuentas, factorizaciones, figuras).
- (+) Un único modelo valida igual en la skill, en el import y en el builder de los cursos fijos. Las fixtures
      sirven a la vez de pruebas y de plantillas para la skill.
- (+) Al niño nunca le llega el texto del dictado ni, si el tutor no quiere, las respuestas.
- (−) El resultado depende del navegador. El número de página «n / N» solo sale en Chrome y Edge, y el usuario
      tiene que imprimir al 100 % y sin encabezados (el diálogo lo recuerda). Para comprobar la impresión hay que
      revisarla a ojo, con `print-demo.html` y `scripts/print-check.mjs`.
- (−) El cuerpo se guarda entero en una fila: las listas no pueden leer `body` (pesa hasta 90 KB), solo metadatos.
- (−) Un documento con un tipo nuevo de bloque obliga a tocar a la vez el esquema, el validador, el renderer de
      pantalla y el de papel.
