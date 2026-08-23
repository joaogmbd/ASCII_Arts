# ASCII CITY — protótipo de jogo 3D em ASCII

Um jogo de exploração em primeira pessoa numa metrópole cyberpunk **infinita**,
desenhado inteiramente com caracteres. Roda no navegador, em um único arquivo
HTML, sem dependências, sem build, sem servidor — e **sem WebGL**.

![rua](docs/street.png)

## Como rodar

Abra `index.html` no navegador (duplo clique funciona — o arquivo é
autocontido). Se preferir servir por HTTP:

```bash
cd ascii-city && python3 -m http.server 8000   # http://localhost:8000
```

## A interface é o próprio jogo

![menu](docs/menu.png)

Não existe uma única borda, régua ou caixa de CSS no projeto. **O menu é
escrito nas mesmas células que o raycaster acabou de pintar** — molduras com
`+`, `-` e `|`, botões `[ ASSIM ]`, chaves `[ SIM ] / [ NAO ]`, seletores
`<  dense  >` e barras `[####--------]` — e o mouse é testado em coordenada de
célula, não em pixel. É uma TUI de terminal desenhada pelo mesmo blitter que
desenha a cidade, e a cidade continua rodando atrás dela.

Enquanto se joga **não há HUD nenhum**: a tela é só a cidade. `ESC` solta o
cursor e abre o menu; clicar em `[ RETOMAR ]` ou em qualquer ponto fora dos
painéis volta ao jogo.

Tudo que antes era atalho de teclado agora também é clicável e ajustável — os
atalhos continuam valendo como caminho rápido:

| Tecla | Ação |
|---|---|
| `W` `A` `S` `D` | andar |
| mouse | olhar |
| `SHIFT` | correr |
| `ESPAÇO` | pular (também no skate) |
| `K` | pegar / largar o skate |
| `ESC` | abre o menu |
| `C` | cor ↔ mono |
| `L` | luz dinâmica · `E` contornos · `M` minimapa |
| `[` `]` | tamanho do caractere (6×10 até 14×25 px) |
| `1` `2` `3` `4` | conjunto de caracteres |
| `G` | outro mundo · `R` respawn · `F` tela cheia |
| `,` `.` | exposição · `;` `'` nível de preto |

Os widgets são de modo imediato: cada um se desenha e, no mesmo passo, testa se
o mouse está em cima e se houve clique. Trocar o tamanho da célula realoca os
buffers, então o `resize` é adiado para depois do `blit` — senão o menu
terminaria de se desenhar em cima de um buffer que já não existe.

![pausa](docs/pause.png)

## Nada de 3D por baixo

Esta é a diferença central em relação à primeira versão (que rasterizava a cena
em WebGL e convertia a imagem para texto num pós-processamento). Aqui **não
existe imagem intermediária**: o frame é escrito direto num buffer de
caracteres, como os engines de modo texto dos anos 90, e só no fim esse buffer
vira pixels.

O resultado é ~**3 ms por frame em renderização por software** (SwiftShader,
sem GPU nenhuma) contra ~55 ms da versão anterior.

```
   por coluna da tela
   ┌──────────────────────────────────────────────────────────┐
   │ DDA sobre a malha de 1 m, gerada sob demanda             │
   │   → registra cada face de parede exposta (h > h anterior)│
   │   → para quando uma parede já cobre o topo da tela       │
   ├──────────────────────────────────────────────────────────┤
   │ piso: floor casting (distância = eye·projV / (y-horiz))  │
   │ paredes: algoritmo do pintor, do fundo para a frente     │
   │ céu: gradiente + estrelas fixas em coordenada de mundo   │
   ├──────────────────────────────────────────────────────────┤
   │ sprites (postes, árvores) com z-test por coluna          │
   └──────────────────────────────────────────────────────────┘
   depois, sobre a grade inteira
   ┌──────────────────────────────────────────────────────────┐
   │ contornos: onde o id de superfície muda entre células    │
   │   vizinhas e a vizinha está mais longe → | - / \         │
   ├──────────────────────────────────────────────────────────┤
   │ blit: máscara do glifo (3 níveis) → ImageData            │
   └──────────────────────────────────────────────────────────┘
```

**Paredes de altura variável.** Um raycaster clássico só tem uma altura. Aqui a
malha guarda a altura de cada tile em metros, e o DDA registra uma face nova
sempre que a altura sobe em relação ao tile anterior — o que também expõe o
prédio alto que está atrás do baixo. As faces são desenhadas do fundo para a
frente, então a oclusão sai de graça. A marcha para assim que uma parede cobre
o topo da tela: nada atrás dela pode aparecer.

**Contornos geométricos, não Sobel.** A v1 procurava bordas na imagem. Aqui não
há imagem — há o z-buffer da própria grade de caracteres, mais um id de
superfície por célula (0 céu, 1 piso, um id estável por face de prédio, um por
sprite). Onde o id muda entre vizinhas e a vizinha está mais longe, o glifo vira
o traço da direção da descontinuidade. A silhueta é exata e custa uma varredura
da grade.

**O terminal.** Cada glifo é rasterizado uma vez num canvas de `cellW × cellH`,
e guardado como a lista dos seus pixels acesos com o nível de alfa quantizado em
3. Desenhar uma célula é percorrer só esses pixels escrevendo a cor já
pré-multiplicada num `Uint32Array` — sem `fillText` por célula, sem GPU.

## A cidade

Infinita nos quatro sentidos, determinística, e nada é guardado além dos
quarteirões próximos (o cache segura ~220 e descarta os mais antigos).

### O traçado

Segue como se desenha um plano viário de verdade:

- **A caixa da rua tem largura fixa** (12 m) em toda a cidade — é isso que dá a
  leitura de cidade planejada. O que varia é o miolo do quarteirão.
- **Os eixos de rua são uma sequência 1-D separável** em X e em Z:
  `eixo(i) = round(i·46 + ruído(i)·18)`. Como o jitter é menor que a média, a
  sequência é monotônica e cada eixo se calcula isolado, sem acumular desde a
  origem — é o que torna a malha infinita e ainda assim perfeitamente alinhada.
  Como os eixos são inteiros e a caixa é par, a rua mede exatos 12 m sempre.
- **A calçada** é uma faixa de 3 m medida para dentro do quarteirão, então toda
  esquina fecha certo.
- **O miolo é loteado por subdivisão binária recursiva** até cada lote ficar
  entre 9 e 19 m de testada. Os lotes se encostam: paredes geminadas, como num
  quarteirão real.

Verificado por teste sobre 256 quarteirões: **zero sobreposições e 100 % das
caixas de rua com exatamente 12 m**.

### Formatos de quarteirão

A caixa da rua e a calçada são as mesmas em toda a cidade — o que varia é o
**miolo**. Cada quarteirão sorteia um formato, e todos trabalham dentro do lote,
então o plano viário nunca é violado:

| formato | o que é |
|---|---|
| `grid` | loteamento retangular por subdivisão binária |
| `torre` | torre cilíndrica escalonada no meio, praça verde em volta, baliza piscando no topo |
| `cunha` | uma diagonal corta o quarteirão em dois triângulos: um alto, um baixo |
| `patio` | anel de prédios em volta de um pátio interno arborizado |
| `vila` | **rua sem saída**: um ramal entra do meio de uma testada e termina num balão de retorno, com casas baixas em volta |
| `praca` | canteiros baixos e árvores |

Torre e rua sem saída em planta (`@`/`O`/`o` prédio por altura, `.` rua,
`,` ramal sem saída, `"` verde, espaço calçada):

```
....                                                  ....
....                                                  ....
....   """""""""""""""""""OOOOOO"""""""""""""""""""   ....
....   """""""""""""""OOOOOOOOOOOOOO"""""""""""""""   ....
....   """""""""""""OOOO@@@@@@@@@@OOOO"""""""""""""   ....
....   """"""""""""OOO@@@@@@@@@@@@@@OOO""""""""""""   ....
....   """"""""""""OO@@@@@@@@@@@@@@@@OO""""""""""""   ....
....   """""""""""OOO@@@@@@@@@@@@@@@@OOO"""""""""""   ....
....   """"""""""""OO@@@@@@@@@@@@@@@@OO""""""""""""   ....
....   """"""""""""OOO@@@@@@@@@@@@@@OOO""""""""""""   ....
....   """""""""""""OOOO@@@@@@@@@@OOOO"""""""""""""   ....
....   """""""""""""""OOOOOOOOOOOOOO"""""""""""""""   ....
....   """""""""""""""""""OOOOOO"""""""""""""""""""   ....
....                                                  ....
....                                                  ....
```

```
....   OOOOOOOOOOOOOOOooooooooooooOOOOOOOOOOOOOOOOO   ....
....   OOOOOOOOOOOOOOOoooo      ooOOOOOOOOOOOOOOOOO   ....
....   OOOOOOOOOOOOOOOoo ,,,,,,,, OOOOOOOOOOOOOOOOO   ....
....   OOOOOOOOOOOOOOOo ,,,,,,,,,, OOOOOOOOOOOOOOOO   ....
....   OOOOOOOOOOOOOOOo ,,,,,,,,,, OOOOOOOOOOOOOOOO   ....
....   OOOOOOOOOOOOOOOo ,,,,,,,,,, OOOOOOOOOOOOOOOO   ....
....   OOOOOOOOOOOOOOOoo  ,,,,,,  OOOOOOOOOOOOOOOOO   ....
....   OOOOOOOOOOOOOOOoooo,,,,,,ooooooooooooooooooo   ....
....   OOOOOOOOOOOOOOOoooo,,,,,,ooooooooooooooooooo   ....
....   OOOOOOOOOOOOOOOoooo,,,,,,ooooooooooooooooooo   ....
....   OOOOOOOOOOOoooooooo,,,,,,ooooooooooooooooooo   ....
....   OOOOOOOOOOOoooooooo,,,,,,ooooooooooooooooooo   ....
....   OOOOOOOOOOOoooooooo,,,,,,ooooooooooooooooooo   ....
....   OOOOOOOOOOOoooooooo,,,,,,ooooooooooooooooooo   ....
....   OOOOOOOOOOOoooooooo,,,,,,ooooooooooooooooooo   ....
....   OOOOOOOOOOOoooooooo,,,,,,ooooooooooooooooooo   ....
....   OOOOOOOOOOOoooooooo,,,,,,ooooooooooooooooooo   ....
....                      ,,,,,,                      ....
```

Verificado em 256 quarteirões com todos os formatos ativos: **zero
sobreposições e 100 % das caixas de rua com exatamente 12 m**.

### O que é procedural

| | como |
|---|---|
| tamanho dos quarteirões | jitter no eixo de rua → 19 a 48 m de miolo |
| altura dos prédios | ruído de valor suave em coordenadas de quarteirão define o *distrito*; o lote varia em torno desse patamar; 7 % viram torre isolada, 10 % viram térreo comercial. Resultado medido: 1 a 24 andares, mediana 10 |
| loteamento | subdivisão binária com corte sorteado |
| postes | vão sorteado em [10 m, 15 m] e depois **corrigido** até caber de fato na faixa; altura em [4,2 m, 6,2 m]. Medido: menor distância real entre dois postes = 9,3 m |
| outdoors e telões | fachada que dá para a rua, posição, tamanho, cor, texto e animação |
| praças | 9 % dos quarteirões, com canteiros e arborização |

### Luz

![outdoor](docs/billboard.png)

Cada poste, outdoor e telão é uma luz pontual real. Para não testar todas contra
cada célula, elas entram numa grade uniforme cuja célula tem o tamanho do raio
máximo: varrer os 3×3 buckets em volta do ponto basta para pegar todas as luzes
que o alcançam. Cada célula de parede, piso ou sprite é sombreada com
`atenuação × N·L` — é isso que faz a poça de luz embaixo do poste e o clarão do
letreiro na fachada vizinha.

![telão](docs/screen.png)

Os painéis vêm em três tipos. Os **outdoors** desenham o texto com uma fonte
matricial 5×7 em blocos, como um painel de LED: de perto dá para ler a mensagem
passando, de longe vira um borrão colorido — igual na rua. Os **telões** rodam
um equalizador animado. E os **painéis de arte** rodam peças de arte ASCII de
verdade, trocando a cada nove segundos, com o painel apagando na troca — a arte
foi desenhada para célula de terminal, então é reescalada com a proporção certa
para não sair achatada.

![splash art](docs/splash.png)

#### A luz do painel é a densidade do que ele está mostrando

Um painel não tem brilho fixo. A cada frame mede-se qual fração dele está de
fato acesa, e é isso que vira intensidade e alcance da luz:

- no **outdoor**, a tinta das letras que estão passando pela janela do painel —
  a fonte 5×7 sabe quantas das 35 subcélulas cada letra acende, então uma
  palavra gorda como `PACHINKO` clareia a calçada mais que o espaço entre
  palavras;
- no **telão**, a altura somada das barras do equalizador, que tem uma batida
  global — a tela inteira acende e apaga junta, e a fachada pulsa no ritmo;
- a moldura, sempre acesa, entra como um piso constante.

Cada região é pesada pelo brilho que ela realmente emite (`EM_FRAME`,
`EM_LETTER`, `EM_BAR`, `EM_OFF`), e as mesmas constantes desenham o painel e
medem a luz, então os dois nunca saem de sincronia.

Medido no protótipo: o *duty* de um telão oscila entre **0,17 e 0,44** e o de um
outdoor entre **0,10 e 0,23**. Num ponto da calçada a 7 m do painel, a
luminância vai de **0,48 a 0,81 (+69 %)** ao longo do ciclo, e a densidade média
de caracteres de todo o piso visível sobe **5,6 %** — a rua responde em texto ao
texto do letreiro.

## Ciclo do dia e clima

![tarde](docs/tarde.png)

Uma volta completa leva **10 minutos**. Tudo que descreve o ambiente vem de
quadros-chave interpolados — céu (zênite e horizonte), luz-chave e sua direção,
ambiente, rebote, névoa, estrelas, quanto o neon está aceso e a íris da
exposição. O sol e a lua atravessam o céu como disco, junto com a luz-chave.

A íris não é enfeite: a mesma cena fica dezenas de vezes mais clara de dia, e
sem comprimir isso a rampa de caracteres satura inteira. O ajuste deixa o dia
visivelmente mais **denso** que a noite sem estourar — que é como o olho
funciona. Postes de rua acendem no fim da tarde e apagam de manhã; as janelas
acesas rareiam de dia.

![clima](docs/clima.png)

O clima alterna entre **limpo, chuva, neve e tempestade** em trechos
determinísticos, com rampa de transição. As gotas ficam num cilindro em
coordenada de mundo e são projetadas como qualquer sprite, passando pelo
z-buffer — ganham paralaxe e perspectiva de graça. A densidade é baixa de
propósito: molha a cena sem sujar a leitura do texto. O asfalto molhado escurece
e reflete mais, o que acende as poças sob os postes, e a tempestade tem
relâmpago que clareia o céu e a chuva por um instante.

## O skate

![skate](docs/skate.png)

`K` pega e larga o skate. É **um pouco** mais rápido que correr — 13,6 m/s
contra 11,0 m/s, cerca de 24 % — mas o que muda de verdade é a inércia:

- demora a pegar velocidade e quase não perde sozinho: soltando o `W` você
  desliza por bem mais tempo do que a pé;
- `A` e `D` **fazem curva**, não caranguejo: empurram com 45 % da força, e a
  velocidade gira junto com o olhar sem perder módulo — é o que separa carve de
  patinar no gelo;
- `S` é freio: para, não dá ré;
- ao descer, o excesso de velocidade é cortado para a velocidade de corrida.

O shape aparece em primeira pessoa e **recebe a luz da rua como qualquer outra
superfície** — passa embaixo de um poste e acende junto. A remada levanta a
câmera e o shape uma linha, no ritmo do empurrão.

## Ajustes

Tudo em `CFG` (traçado urbano) e `TUNE` (mapeamento de luminância). Os quatro
conjuntos de caracteres e seis tamanhos de célula trocam em tempo real:

![mono](docs/mono.png)
![blocos](docs/blocks.png)

## Próximos passos

- interiores e elevadores
- carros e pedestres (sprites já têm z-test)
- manobras no skate (hoje só rola e freia)
- áudio e controles de toque
- ruas em diagonal / avenidas (hoje a malha é estritamente ortogonal)

## Histórico

A v1 usava WebGL2 com MRT, Sobel em luminância + normais, e composição de glifos
num shader — a técnica de "graphics to text" popularizada pelo Acerola. Está no
histórico do git, em `178d2b8`.

## Créditos

- Ideia central: ASCII CITY Prototype 1, Grow Now! Games —
  <https://ko-fi.com/s/e1e0f91951>
- Arte ASCII dos painéis: <https://ascii.co.uk/art>, mantida com a assinatura
  de quem a fez (lmg, anubis, mark, sk, ejm, jgs)
