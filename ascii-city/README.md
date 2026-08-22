# ASCII CITY — protótipo de jogo 3D em ASCII

Um jogo 3D de exploração em primeira pessoa cujo frame inteiro é desenhado com
caracteres ASCII. Roda direto no navegador, em um único arquivo HTML, sem
dependências, sem build e sem servidor.

Inspirado na ideia central do **ASCII CITY Prototype 1** (Grow Now! Games) —
uma metrópole cyberpunk feita de texto. Este aqui é uma implementação
independente, com engine própria em WebGL2.

![rua](docs/street.png)

## Como rodar

Abra `index.html` no navegador (duplo clique já funciona — o arquivo é
autocontido e não usa módulos ES nem `fetch`).

Se preferir servir por HTTP:

```bash
cd ascii-city
python3 -m http.server 8000
# http://localhost:8000
```

Requisitos: qualquer navegador com **WebGL2** e aceleração de hardware
(Chrome, Edge, Firefox, Safari 15+).

## Controles

| Tecla | Ação |
|---|---|
| `W` `A` `S` `D` | andar |
| mouse | girar a câmera (clique para capturar o cursor, `ESC` solta) |
| `SHIFT` | correr |
| `C` | cor ↔ mono (verde de terminal) |
| `E` | liga/desliga os glifos de contorno |
| `X` | mostra o render 3D cru, sem ASCII (ótimo para entender o pipeline) |
| `V` | efeito CRT (scanline + vinheta) |
| `[` `]` | tamanho da célula: 4/6/8/10/12/16 px por caractere |
| `1` `2` `3` `4` | conjunto de caracteres |
| `G` | gera uma cidade nova |
| `R` | volta ao ponto inicial |
| `F` | tela cheia |
| `H` | mostra/esconde o HUD |
| `,` `.` | exposição |
| `;` `'` | nível de preto |
| `-` `=` | limiar de contorno |

## Como o 3D vira ASCII

A abordagem é a que se usa hoje em *shaders* de ASCII art (popularizada pelo
vídeo do Acerola sobre "graphics to text"): **não se desenha texto — desenha-se
a cena em 3D normalmente e converte-se a imagem para uma grade de caracteres em
pós-processamento**, na GPU. São quatro passes por frame:

```
                 ┌───────────────────────────────────────────┐
   cidade 3D ───▶│ 1. cena (MRT)   alvo0: cor  alvo1: normal  │  W × H
                 └───────────────────────────────────────────┘
                                   │
                 ┌───────────────────────────────────────────┐
                 │ 2. Sobel sobre luminância + sobre normais  │  W × H
                 │    → magnitude e ângulo da borda           │
                 └───────────────────────────────────────────┘
                                   │
                 ┌───────────────────────────────────────────┐
                 │ 3. downsample: 1 texel = 1 caractere       │  cols × rows
                 │    cor média + histograma de direções      │
                 └───────────────────────────────────────────┘
                                   │
                 ┌───────────────────────────────────────────┐
                 │ 4. composição: escolhe o glifo e amostra   │  W × H
                 │    o atlas de fonte                        │
                 └───────────────────────────────────────────┘
```

**1. Cena.** Rasterização comum em WebGL2 num framebuffer offscreen, com
*multiple render targets*: o alvo 0 guarda a cor iluminada; o alvo 1 guarda a
normal codificada e uma máscara (alfa 0 = céu, 1 = geometria). A cidade inteira
é uma única malha estática, desenhada em um só `drawArrays`.

**2. Bordas.** Um Sobel 3×3 roda sobre dois campos: a luminância (pega detalhe
interno, como a malha de janelas) e um escalar derivado das normais (pega
quinas e silhuetas contra o céu — inclusive contra o céu, porque ali a máscara
zera). Fica a maior das duas magnitudes, e o gradiente correspondente dá o
ângulo. O ângulo perpendicular ao gradiente é quantizado em 4 faixas de 45°,
que correspondem a `-` `/` `|` `\`.

**3. Downsample.** Cada texel do alvo é uma célula de caractere. O shader
percorre o bloco de `cell × cell` pixels acumulando a cor média e um histograma
com 4 baldes de direção, ponderado pela magnitude. Se o balde vencedor cobrir
uma fração suficiente da célula (`uCoverage`), a célula é marcada como traço
direcional; senão ela é uma célula de densidade.

**4. Composição.** A luminância da célula passa por um nível de preto, um
tonemap exponencial (`1 - e^(-l·exp)`) e gama, e o resultado indexa a rampa de
densidade — `" .,:;i1tfLCG08@"` por padrão. Células de borda usam o glifo
direcional. O glifo sai de um **atlas gerado em runtime**: um `<canvas>` 2D
desenha cada caractere numa célula de 16 px e vira textura, então trocar de
conjunto de caracteres é instantâneo e não há nenhum asset externo.

No modo colorido a cor da célula é normalizada (matiz preservado, brilho vindo
do glifo) e quantizada em poucos níveis, que é o que dá o aspecto de terminal
de 256 cores.

### Por que essa ordem importa

Fazer o downsample *antes* da detecção de bordas destrói justamente a
informação que os traços `/ | \ -` precisam. E detectar bordas só pela
luminância perde as silhuetas dos prédios contra o céu escuro — daí o segundo
campo, baseado em normais.

## A cidade

Gerada proceduralmente com um PRNG determinístico (`mulberry32`), então a mesma
seed dá sempre a mesma cidade. Grade de quarteirões de 17 m separados por ruas
de 9 m; cada lote é subdividido em 1, 2 ou 4 torres, cada uma com até 3 volumes
empilhados com recuo. Prédios mais altos perto do centro. Alguns lotes viram
praças. Antenas e caixas d'água nos telhados, letreiros de neon nas fachadas,
postes de luz nas esquinas.

As janelas **não são geometria**: o fragment shader recebe UVs em coordenadas
de mundo (metros) e desenha a malha de janelas com `fract`, decidindo acesa /
apagada / cor por um hash da célula. Isso mantém a malha em ~7 mil triângulos e
alinha as janelas entre volumes empilhados.

Colisão é AABB 2D contra a lista de bases dos prédios, resolvida eixo a eixo
(o que dá deslizamento na parede). A altura do olho interpola ao subir na
calçada.

### Duas armadilhas que valem registrar

- **`flat` no atributo de seed.** O seed de cada prédio viaja num atributo de
  vértice. Interpolado, ele varia ~1 ULP entre pixels vizinhos — invisível
  sozinho, mas os hashes amplificam isso em ruído por pixel na fachada inteira.
  A correção é qualificar o varying como `flat` (e usar hashes robustos a
  entradas grandes, no estilo Dave Hoskins).
- **`glClear(DEPTH_BUFFER_BIT)` respeita a máscara de profundidade.** Com
  `depthMask(false)` herdado do passe do céu, o depth buffer nunca era limpo:
  o primeiro frame desenhava a cidade e todos os seguintes eram rejeitados pelo
  teste de profundidade. Só o céu aparecia.

## Ajustes

Os parâmetros ficam todos no objeto `S`, no início da seção de estado:

| campo | efeito |
|---|---|
| `cellIdx` | tamanho da célula (índice em `CELL_SIZES`) |
| `exposure` / `gamma` / `black` | mapeamento de luminância para a rampa |
| `edgeThresh` / `coverage` | quanto de borda é preciso para virar um traço |
| `lumaW` / `normalW` | peso de cada campo na detecção de bordas |
| `levels` | níveis de quantização de cor |
| `fog` | densidade da névoa (define a distância de visão) |

A resolução do render acompanha a janela, limitada a 320×200 caracteres; acima
disso a imagem é escalada por CSS, mantendo os glifos nítidos.

## Próximos passos

- interiores e elevadores (o protótipo de referência tem os dois)
- oclusão / culling por quarteirão, para cidades bem maiores
- controles de toque para celular
- áudio
- tipografia com largura variável de célula (fontes não são quadradas)

## Referências

- Acerola — *I Tried Turning Games Into Text* (shader de ASCII com detecção de
  bordas, quantização de cor e atlas de glifos)
- Winnemöller et al. — *XDoG: an eXtended difference-of-Gaussians compendium*
- ASCII CITY Prototype 1, Grow Now! Games — <https://ko-fi.com/s/e1e0f91951>
- WebGL2 Fundamentals — *Text: Using a Glyph Texture*
