# Frost Lab / 001 — Esfera navideña

Experimento de renderizado con **Vite, JavaScript vanilla, WebGPU nativo (WGSL) y Rust compilado a WebAssembly**. Una esfera de metal rojo pulido refleja la cámara del dispositivo y un entorno de estudio con iluminación HDR, copos grabados y un casquillo metálico dorado.

## Iniciar

```sh
npm install
npm run dev
```

Abre la dirección `localhost` que imprime Vite en un navegador compatible con WebGPU. Selecciona **Activar cámara** y concede permiso. Sin cámara, la escena utiliza un estudio virtual. Toda la captura y el procesamiento ocurre localmente; no se graba ni se transmite el video.

Para acceder desde otro dispositivo, utiliza HTTPS: la cámara y WebGPU necesitan un contexto seguro (localhost es válido).

## Controles

- Arrastrar con mouse o dedo: rotación por cuaterniones, libre en tres ejes.
- Rueda o pellizco: zoom.
- Doble clic o `R`: restablecer la vista.
- Barra espaciadora: auto-rotación.
- `C`: iniciar/detener cámara.
- `H`: ocultar/mostrar controles. Hay también un botón para recuperarlos.

## Pipeline

1. `CameraFeed` detecta frames nuevos mediante `requestVideoFrameCallback`, con alternativa basada en `currentTime`.
2. `copyExternalImageToTexture` copia cada frame disponible a una textura sRGB sin leer el frame completo en CPU.
3. El shader `env.wgsl` proyecta la cámara en un render target equirectangular HDR `rgba16float`, de 1536 × 768, con una proyección equidistante configurable. La zona no capturada se completa con el estudio virtual; una sola webcam no puede reconstruir todo un entorno de 360°.
4. La GPU genera los mipmaps del entorno solo al recibir un frame nuevo o cambiar los parámetros de proyección. El material base es metallic 1 / roughness 0, con Fresnel, normal map esmerilado, barniz opcional y antialiasing 4× MSAA. La reflexión usa `reflect(-V, N)`, con filtrado según su huella angular para evitar aliasing en el borde.
5. Rust genera la malla esférica, el casquillo con anillo y la textura de grabados de 2048 × 1024. Una sonda de armónicos esféricos L2 estima la luz difusa a partir de una miniatura de la cámara de 64 píxeles de ancho; utiliza pesos precalculados y actualiza hasta 15 veces por segundo. Esto no limita la frecuencia de las reflexiones especulares.

El panel muestra los FPS de renderizado, el tiempo CPU, los frames de cámara efectivamente subidos por segundo, el tiempo de la sonda Rust y la información del adaptador GPU. El objetivo es 60 FPS, pero depende del navegador, GPU, pantalla y frecuencia real de la cámara.

## Compilación y pruebas

El WebAssembly precompilado se incluye en `src/wasm`, así que no necesitas instalar Rust para ejecutar o compilar el frontend.

```sh
npm test         # Pruebas JS y de las funciones WASM reales
npm run build    # Distribución estática en dist/
npm run preview  # Servir el build de producción
```

Si modificas `rust/src/lib.rs`, instala Rust, el target `wasm32-unknown-unknown` y `wasm-pack`, y ejecuta:

```sh
npm run wasm
npm run build:full
```

**Autor:** Frost Lab. Implementación inicial con Claude y continuación con Codex.
