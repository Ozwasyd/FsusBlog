import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const deniedFingerprints = [
  [7, 3355345876, 'e54154cc0a4e97e99609fad08e18f6b463e7c530d836baef6d67c1ec11ddde59'],
  [9, 3355345876, '428f62af983ff35f3fdfddf9a6ecb5e6d4d3bc55fe59a8ae0987835e481dcd6b'],
  [9, 1726480038, 'e443c96ab2aad6d4084cced768b60c208a56d5071285a0d2b712a25c31f2f229'],
  [9, 1727342782, '50aa4f3ca9a8ab3b348eed6a3d26d3a259ec01d2d96b9ed502e6c91c81b51861'],
  [10, 830462980, 'c8cfd0342ad6ee5134b284e65b3000f09805924ab96cb697d3ec803e9a46ed07'],
  [10, 3355345876, '60efbe0515fe1195e0491dd9b80de81a7f565c1aa7a372b53b11d0198521202d'],
  [11, 1696578777, '11114ee937d7efcdaf7be75cefb8fc09392d658239d60b0b269de0357615eb93'],
  [12, 335870966, 'b7703268e7ec7fd6a0cfc39de24f3d7c10ee8dbe97e64174570cf3f036a2572c'],
  [13, 3355345876, 'c4e2a732a4defd3d1df6adc6c411497386313d3ee324915c5b0758160efe10a3'],
  [13, 3702506228, 'dfb71a8169d160bd203c93f7c39d356bc89262c33d0f47d480b0524315c07d47'],
  [14, 3355345876, '0abccc4edf992e3679bcc21b2b6742afc0bc48e905a2761165692ea0c9e6afaa'],
  [14, 3355345876, '81d322e051de2b28c016c724d68c2049dd3572cbe2496646d2eef4d9174b38f6'],
  [15, 4258981375, '8c942a38ebe1aff58c21a12f21dc8d9b324f57d31d318d6a84965019dd981cfa'],
  [15, 788984558, 'a80d4cf1851ad16ff735d9d8fe02ae252a36094203cef42ee4aa586d400bde16'],
  [15, 1701263629, 'eb6b050e13a898a69d9559067cae614f7e738cce6c35de1e14dd2459e91773ef'],
  [16, 3355345876, 'b9998c4767f5b287c903631fb4182ad3e56ff95eb25a7e6f014484489790c19f'],
  [17, 3355345876, '8f3e8732c6b81ec0331773d8213a64d2af6c90500b8b684db35357a75c5c0626'],
  [17, 1313879054, '2cf8b3fc7a41cf5c8cbecd46d3046cc6e28a7fff8987f9ce93cb2f23cd735773'],
  [17, 4105285355, '6c9336928650ae078c97a8e4f93ed8bb4a56a553f85029231080ffdffbc610b6'],
  [17, 2271944429, '18f0ef2d28eb9481fb01a5c6c99d66aab35fd392ba469b0ebb02831368b7aab4'],
  [18, 3355345876, 'a3c16113331098bd57aa9b42cb91960f6d02cdca09e6cd6f9bfc46fceecbb13c'],
  [18, 3955541747, 'fd8008cc27b6ef6ad16129c5af73b0e05f4a9e5800fef07a904de8c5dbb2216e'],
  [19, 3355345876, 'eab9160f5674216bedef79b3dce6690efadec97a7841c434a3de3df0173385dc'],
  [19, 3355345876, '4113094abaef89eae0208fdb471a1141227a26775d2135b44d54641cd789859b'],
  [19, 3355345876, '64b39d8f9142f7b2317fa90090fc47de9fbd6b271cca212cbbc5040a27e8ab6b'],
  [19, 4258981375, 'fc47695516f3176884b72db8feec334665746cf7d09d7910f48670ddcc84bd84'],
  [20, 3422222837, '6ba7a21cbae800b4186d5c2a06aab0f3588a10dc9aae853501a6914f1cfc08aa'],
  [20, 3955541747, '4e5b10516a2898411ef9e18becf32c6eb68f971575d06e5de767bd9540993024'],
  [20, 3955541747, '216e405cff2ed1197f4adbdc72c708fcd2e7ae90b23c832826304fc697b828ba'],
  [21, 3355345876, 'dc1015fce77298357bc622c47be74bb4f2977ff9617fee4c96981792a29decf3'],
  [21, 3352682990, 'ed22ab5904613f1c07f8d265273ef7424a796a411de1c45a7d40e0686980705c'],
  [21, 3955541747, '2cc47b3a0bfbda6b2ee2f5425a0c3b2b52b29a89dfab69676af4d4145dde59d4'],
  [21, 4258981375, 'fc0c5e6c4e6105dd369cd0e876b94fe67de13194245f86142dbaea8cc021dbce'],
  [21, 1576244671, 'f858d74f4a7074567c0bcd0367381fb499ae2331983408fce71554199927629b'],
  [22, 3355345876, '584068659f19eeeb220836c8fd37672f9f25d993ba692846408fc5a7cbba6937'],
  [23, 3355345876, '1f97f418b8e992ef830209970a80b11536e261ec92b4f0cdd00fd8e79523f4e7'],
  [23, 859738855, '50523b36338f2eafbb6bf5410e69a025507152183202aa18d9ad9ebd05474ace'],
  [23, 3302386144, '85f228ce73243bc8896d53f642550608778b250ff6a173c78218cface7a63df0'],
  [24, 3355345876, '66f61f6e459a7897a829bd684aa6d0283526155fbec13a24365772ef2ce38e7f'],
  [24, 3355345876, '1e029f30869efe6e7578fb0426ee3d33eb3c3e2f582bb7a3e061dc7ae35c2c35'],
  [24, 4258981375, 'ac002027918ffd336fb580af24b0ce8339c97790bfd559fcda3e31feb96edcd3'],
  [26, 3355345876, 'fa8049712f3934e3d6ec7d973bcf9da2ca3b2dece13717c1fa9e52853c28ba1f'],
  [26, 3355345876, 'bf76275db0c1a8da96e233f1604db224110f921ce090e2b182720bf8c2426525'],
  [27, 4258981375, 'c1718b67f79e4f3b5f551c75b39a975d540981ed05823b7bc7b2cd4a02c14a24'],
  [28, 1210514937, '31f16a7eb872fa02c14d65f6f4801f1cfb85ff392edc2d06f96fb9f166e170d5'],
  [29, 4258981375, 'e6c016a6c48afa13b761c75b4e7e067ea2f3cf2526af417ecadd638375471567'],
  [30, 2250975920, 'd3f9a6b9fa40b6409d319f35fd52767bc8f4b0b6d48cadcf5eeaca5a65b0c7eb'],
  [31, 3355345876, '9da957d7e668eb5b083b0eae63251bde96f28e8806122fe474246510acb0384f'],
  [31, 4258981375, 'e913f2f0a91983b9756e80f9622ba8472ec9de42ee92098bf7f486b1006e68e9'],
  [32, 3422159614, 'ae2c2d31005c0e570c5ae54dc43582900e61de92156397c2ea8237d1ea0cf1d9'],
  [33, 1484171988, '0a0b19c87ace5ba22478c2d2ae06a2f1ceeb59dfdf795c1314e17cb5c121d3c6'],
  [37, 4258981375, '508f0d0c3f2c9c55fb8f47c578a296bace8c114e239ef27f182cc80ba4479976'],
  [38, 1860273958, '810fac9481efa1a6465c1d9657f1c0d52e9b2d55ab83b844424e054e646785bf']
]
const deniedEncodedFingerprints = [
  [10, 2218786497, '9e04137b2f61fc467c2c92cfe28d67d1ec1f976e2f7cea6c75aa3e92b9a833e6'],
  [14, 1178226030, '4597eae4c6ec6163947ad5d2899f235b0da5c908c37bc977c776527801885420'],
  [12, 2218786497, '2453c1ce1fe19d5412070cb3ab08bfda7374a3c353061b0b4c7e86f440b4d194'],
  [18, 1178226030, 'b644a7867982e482108b057ba800eee4a946fcc02f6e7c183164aba344744860'],
  [35, 3821522617, 'ce1ef06f02ae1952d5add87298888823c96e578a2afaa5d1871e911d56eaf2e4'],
  [52, 505168236, 'ef4ac82725081b748382107161c407e4611d4819397e7a4bf4f01f18a84f0df9'],
  [31, 3821522617, 'c4321d6cc472f973bc23896c495f78a709c9e8725154a5549f8f4ce590f3011d'],
  [46, 505168236, 'aad144f540a1d8f5f082d4c75471b7301c274b067ef6950899ba41056eb010e9'],
  [30, 3821522617, '72120ba8a8a086ddb0521e8a6c637d8d1e7742df97e9c6d61383352e5bf27355'],
  [44, 505168236, '4c7a81b732f61f45fdb39dce94746fb9f59c21808e143749f18e7048fedc29a8'],
  [35, 3821522617, '2fe9f27509bba90b9aa6716803eac42da03cd4b9569275cc731a6c38b287ee38'],
  [52, 505168236, '79e7824cc55e8dd88d1d2314cba50251d243b30f90ef19cb771fd8f7c3b20c62'],
  [42, 3821522617, '55ed6c4cd78177c580aed953993ec3e4cd39785b63330b08c51dfb353f6083ed'],
  [62, 505168236, '1733cca7d1241cd0408dd2d2aea475ef0a9f158f83cc6c6233908b007a6d9915'],
  [28, 562282202, 'ae37564fdd233c4b15169356e8b5babf3594b7144d248409c0fa6c28b1318f02'],
  [42, 1077367409, 'fab760806bcf3004429bd1c24c0f5d00765a4c9dbe50b482b932ef3b8f28533c'],
  [27, 562282202, '3130444e750a86b6e4d8b348e3e81443674c301c10e59dfdc4a95f491a0160e8'],
  [40, 1077367409, '3a2117b4a14a16c71ed45fba4b2643cd2820b988fcfa83cbd13a322534d1601e'],
  [24, 2324835052, '037bd563c82b21313e96c8806e79d08691e94d672b11bb42c883709c50550e93'],
  [36, 404309615, 'f7d6d39b80593475706a9c9d3c6c30ea1d555fa312005a4191ad7c8aba79d49a'],
  [27, 562282202, 'e900ee787a9f7639eda0c1250738eb17e1c07ade1c36bd7a98a7f1a19e28a5e2'],
  [40, 1077367409, '15b0a1800e0e5e44d413dffa71a618146c869072eb95acb7c3d05f33cba3bf16'],
  [28, 1596892976, '9edf7e39d8d870b313895d01222e54248312a35d5075003a9875dc09e4cf629f'],
  [42, 1701408887, '8bb69e8d224bdad88615e3bf1772fac2271c257109d3e8ed5ce4b86f8c73fb86'],
  [14, 1993697195, '8481863bd03038e7e549cf27ba956641b66762471551b91a5cded72d3c60c680'],
  [20, 1724048035, 'a8ea81d71535d4b44a4aa66ea565e4b4986e4a328a406327d006c024a18a43ac'],
  [15, 4021156973, '894208c66352fe338fffa8eb46a2f4ea6200f113e30bf08bcfbdfe99d124f882'],
  [22, 1751084156, 'adbbbd3ba95281ddd9356eb1d05c6a374a30b2f0947c433e457811ac8249df6f'],
  [12, 2371687881, 'bd3367c2dff8c786208181127ea8d6ef6965326a618bcd827817f2cb146004a4'],
  [18, 3071424468, '46b9045ab0f64406dabe2566a53442af122e72bb2996d671bcee968117fe753e'],
  [12, 2371687636, '83d1d12fd6a2f7601ba1fd629e3e41676d12596d2ad9aa2f08faaab4e47e6e23'],
  [18, 3071424468, '641edb25293ae2122d65f77fd807f2854bfcc938904734d04f1cec31f334f3bc'],
  [40, 3423442126, 'afb515739690209ee3828b071d3a6d8651ddc32f3f6c9978f1a34dd125f32b60'],
  [60, 1784966004, 'dd3005a700f324ce8e10e7ba499149b9ec37ab668a13ae00f24e4f9b49332b19'],
  [39, 1732055245, 'bbbd38c982fb0a94bba0007bbe1d90f4b445d13bec756f0795bfd3912086f68d'],
  [58, 909530227, '7fc2fd294a2197bed1e42006247e96ef06ef031ef2d63815d54d270266c7f7bf'],
  [42, 1732055245, '2768b4a1dbd1ad5fea158b17b4d59ced76d6110ec872ae9681988bf2fb6ce380'],
  [62, 909530227, '6a2b9d8209cb6bae9c445812d462a0a2739d35002bcd30cdddc8e976202384ce'],
  [43, 1566179025, '7a21ac7788740feca961864413903a389160a8eb80ae0f8931e58be4c84e41d1'],
  [64, 976769905, '6bded5e1b2959c3ac3c35886fdee721faf1b5b9ab753a5b3d4785a7814e03c4f'],
  [51, 1732055245, '422c5166be10b0ac50fa77d4b367619816bd13e896ee6fbadbc779e26bfe4f62'],
  [76, 909530227, 'c3268449c6be4a169de0dc62d582964666a352fd65fe56e2c4520175c3aca25d'],
  [50, 1732055245, '9ba3b3cd58c399e920505cde903f9688a0ec7cde3b737a6c78632d7f65ecd186'],
  [74, 909530227, '7cd073bf43b66ae0600a789722d638fc95e0e9bf15d17c4384a626ab6fa19db0'],
  [38, 2675765703, '2f22a5db8ef318957e91402953a241b39e04e3d600334c0579bdc02d0d4c42f9'],
  [56, 809065846, '44c83938d7be1ef672a353f219c912181d90d90e613e4e08df61547c3d64e96d'],
  [27, 730600832, '26b99522adb50c42778fc8d9c8633163632ba63bde12da9f1d3371680411a554'],
  [40, 1111908215, '3a9b996dd2daa0e1e13d748c0c8aa5a1cf3ba9389905b66a9cd53c50e76fdcaf'],
  [28, 2218786497, 'df86ebc341dd2c7afca38ce54c78ba1f63f206c82b08246e0d9c09fa099c704c'],
  [42, 1178226030, '7ff2681509a2fdac7864de7d2cc6ac84818b1702e08bd9d11d326bc6ff94957e'],
  [28, 4264469691, '1543b6754029c330e90f868fe7f3f2586c0dba43d9fc5d7f5a185180bc4f43f6'],
  [42, 1582588021, 'f104857a487b8287181106e11eb2a03a6e5355b7fedbd51d23222541e9108521'],
  [19, 2218786497, 'c36834bbf559babab58784ca2dcefc70d8259c3e0cc2ca4afdfe04cf2af0232a'],
  [28, 1178226030, 'e0d3c79cc05d3565f6e9a99d4633ae14ff169a45fd9440791afabfc2fffc15f1'],
  [28, 3792408964, '6be47d7bf369d6c320d081a5346490c7045fd5744da4296888640facbfcbfdaa'],
  [42, 2188470901, 'a20ff5bba952d67d1d7c80215add1643d15e47559abddedee65b4776cbdd2282'],
  [23, 299548808, '79976067e1f1d57689528211bb5e9f296fb1f8e0e278612279dfcacb1af0d2b5'],
  [34, 2414355414, 'd0496ab6c87a7982a87fbe01e9c148a25d37709040765e6b36847f3f6be5dede'],
  [32, 3821522617, 'd502a6198a663e5722dd5a53389d5904d275d09fc80ed20e5ca125a18c157c50'],
  [48, 505168236, 'a76fbca413402d552bd0e4d394d192d2442885675f06ffb44778ba771bc2ebcc'],
  [26, 3821522617, '7f36599f322303a009334de905f595c0865c0e519536f37c4fb1e12bd933291d'],
  [38, 505168236, '5ba0f7a9c91b003d4076d0599baccf4d046c7d7071bb704c5ae5e398e7105d83'],
  [24, 3821522617, 'f06572a6899a8f5700d5d85ce7e746aa1223efbf1c29dc2f7d1044ffe0392609'],
  [36, 505168236, '57575f3499fe18b977cbcc923cb6d2eec9c0e1a9345326d26d8ede131fc327f6'],
  [31, 1059062272, '7ed5d5dd311a398e4a6a367be4ed053d4f2a7ba05ab2a9a7f05f7c1dffd43e59'],
  [46, 741430130, '2bda1fee91197f0d1f58b6dbca5c868d0aae1f690fa720ac58acc723ea62348a'],
  [32, 1732055245, 'ce746304a8e91a0d44a95de910161e1f4012853b87bd9cd75594807f29a74970'],
  [48, 909530227, '9da7880e76eaf3e57b9f288e606b458c4bc63966927188c9aa54a6ab747f083e'],
  [32, 3821522617, 'de250400362e207b1a1274d48640aabc137913f8a5ae91b2f61828515566452d'],
  [48, 505168236, '87a5ea60357cad1bbe81226ecea54af8708218418f16627ec8c0635d9f810a25'],
  [19, 3821522617, 'e7fca54332a7d1ce94e3a551062423884be7dd42bb7b8bddc3e6cdc1b345ffbb'],
  [28, 505168236, '4f7221dfe89d92f10860d55a1c3086f9d0ebe6617a714bd4a71748fa1da68daa'],
  [18, 3821522617, '0e0776e44bbd000dae356e40997ba41e0003b3cce60a32138c38bab19f1a76b4'],
  [26, 505168236, 'b036f0f3aefcaefc8e35d589186eabe03ee9fd56b074b8d356ce88a6d24d4463'],
  [26, 3821522617, '73c30fca25b5bf948d7941631875c2ab2494ccde8d8e95796901db87fe27135e'],
  [38, 505168236, '9ab7561c237e66c0c7ddaa36251dbecd5ee6b89e0b0b0b56e9a6f3433e0d978c'],
  [26, 3821522617, 'e851a791223842210f495907450b45f86e735be23e916f1a08f410424d267a66'],
  [38, 505168236, '6c05cc021e0bda27bbc5b3d64962930c8cd36e43199012ab930fcffb0072d78c'],
  [22, 2218786497, 'd7e5bdda14fc8637b53e3f02de095ae9903f888137383812deb6208fc01ca29b'],
  [32, 1178226030, '52596296d812a11b210cbca607aef2ef79ea268f4e3a8f16e3f480bd046371ac'],
  [20, 4021157809, '161803226fdd8ee51d0f5c02056a4442445433fdb3fb98a3d39c48ce3dab1811'],
  [30, 1751084156, '4c6ae279d7a23bf9181f7d8284001d166a5c68778df2cbea227f6e977f9ebf06'],
  [18, 2187539415, '35a973efa187719cb3677fb5072debce72fed0b8ec75b2d5654d6fd71f030325'],
  [26, 673215903, '090f3abb9296606f4c18c0064d606f6795a86d29a804f0cfa30e2a85ecc202ac'],
  [31, 4074634717, '0a17dd2aa2685b5ade771048e7867d4561f6ef12d10df618bfa41477d86fbb60'],
  [46, 589581169, '13eb029392f8008c7b2715b5a3629c1791fdc2414b5c3a7bbed952a4209add6c'],
  [20, 1124787389, '836aaf53c92989388f3dd2f947830a35c9e27f4b9a54574fa8a9c607c5f7b526'],
  [30, 977429626, 'c381055d82f618a043f71e0452ad277079782b8abe10849a04d0d36d72d17457'],
  [23, 636409223, '93472f3bf662004435b2d6be46414c164b87df055ab454818b7ad87aa347e60b'],
  [34, 1909069011, '3641ffb6fda5bf8af3a1b256bcb351bb4bd8728546803a173c65f262d66abdc3'],
  [16, 1259379587, 'fd7ae77827fb6fbcf5ae50db6276f3b43eea3ddf14e82e940ef85c35e475f154'],
  [24, 1909321181, '410351fe6835713769851a7f298642db2edff4733b1120c17b4c852cfa438457'],
  [23, 4900025, '413601ade25b3c7c06e7dbb3e29b4ee2bbf6f1563395896c3ef601538d6d51d9'],
  [34, 1582588534, '8fd7f620fc1e752a5cba2a069481ef2328a9efe83f0645aec3c43acc3b06a95a'],
  [23, 2218786497, 'ab9083c16f6afccca9b60bd10ee80f2e3ec2347aa26ed841918742acc0e41329'],
  [34, 1178226030, 'e99bcb5113656568f6a66c51fdf7829eacbe5c6806f4393c56d8fafd905d4e23'],
  [36, 1732055245, 'b64fb465b3addebccc28fe94b0a2930c4f0bdd81ac92150097134f2e112c429d'],
  [54, 909530227, '69e840260cb6be2ee75339dff8413805f324821675f9ebb7c74ae7a3c0094966'],
  [20, 1732055245, 'a29099671291650e98ac2112d575b6142a12440742472b86dbaebcd83492088b'],
  [30, 909530227, 'c67151dfd64f7a0c24f3ff3182c07cbac54f155ccd7ec40c787b7a6f932f1187'],
  [26, 1732055245, '6f99d34689048fdd7f82492f7e01d5803826aca87ed0d7825bac9f4caa534ed8'],
  [38, 909530227, '1b894404ed6c8ee72aee88e7aba2e038379a2db0729186fb925c0c190b29a983'],
  [44, 400708104, 'a592caf63c2732f10b52aedd6cebbee19feef3a5090e82de589c91d180676fa4'],
  [66, 1145134969, 'a741478032f55cc570f8c82c371e39325cca1dd15a61a7d0e7354a3072dbdd01'],
  [14, 2218786497, '99f7edc36422b31ccdac1a9d7cd894f6bb88e1b398adca379047e2921725035e'],
  [20, 1178226030, '9f0a55c241362399ca2b3b84cdc89b0bc88778759acc23c9090dc0b548a23738'],
  [10, 3821522617, '5f3f8719b4b32035bffe24d90010e1ce2cb316574a10a2c116fc20c457d7ecdf'],
  [14, 505168236, '626da5f11bce9c4b0fde7a2944e3cf2bec36cf684ddae32118a032ee29472109'],
  [12, 3821522617, '4725a7e71645dc14f9f9e3e74e303a259d26ac260e35b76c7c7dd7873299e0a0'],
  [18, 505168236, '5f0c6f37151838f2eadf30075e94abd5fa1c8909176dacd4d3fdaf5637d62c90'],
  [28, 2324835052, 'bff74e7f7f54b99c4daa61c44858754cd3d6deea3e5eb8f6e8a69533c1e99429'],
  [42, 404309615, '5076f260d1884fbe2d5abf7c66299803b16620c4d8547cac612acd4fef2b5128'],
  [27, 2324835052, '4d54692fd744bddc97e251a6726fba33ca9b9589c78c28a687158722ed2d19b1'],
  [40, 404309615, 'b0728b3887a81b0f1fa25ffd1bbe4c6d73d403c1c1d53f29f4d318a6dedf0837'],
  [28, 3199629096, 'eaca13d9786e82a6e131293547edb14d52f72d61dd82b211b7debf4c8f38e3ca'],
  [42, 1028351093, 'ead043427b5e36dcefca893d2f6e5935c78c28998ae07de3cbf2114221d63868'],
  [22, 3821522617, '17ca21b7280fe685116fe6179c2225e29ae271a44968bba2d55ca44657c5156a'],
  [32, 505168236, '5f982e399bcbf75ee16a5b77fc59cf2a079b466f0d04548b2467cbbd4cb43ce9'],
  [20, 1488743363, 'b4ba658b897c55f321bdea1254cc5366faa22018aa92d08b01985624afaaa740'],
  [30, 1078026362, 'b93e5752ccca1bec33836c252dd5f45f9adb72a5bd9c4235c78e8fb9ea8e181b']
]
const deniedByPrefix = new Map()
for (const [length, prefix, digest] of [...deniedFingerprints, ...deniedEncodedFingerprints]) {
  const bucket = deniedByPrefix.get(prefix) ?? []
  bucket.push([length, digest])
  deniedByPrefix.set(prefix, bucket)
}
const historicalNote = 'docs/history/retired-character-challenges.md'
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const retiredAliasPatterns = [
  /["']character["']\s*:\s*["']text[-_ ]?task["']/iu,
  /["']text[-_ ]?task["']\s*:\s*["']character["']/iu,
  /\bcharacter\s*=\s*["']text[-_ ]?task["']/iu,
  /\bcase\s+["']character["']\s*:\s*(?:return\s+)?["']text[-_ ]?task["']/iu,
  /\bcharacter\b[^\r\n]{0,80}(?:=>|\breturn\b)\s*["']text[-_ ]?task["']/iu
]

const normalizePath = value => value.split(path.sep).join('/')

function parseRoot(argv) {
  if (argv.length === 0) return defaultRoot
  if (argv.length === 2 && argv[0] === '--root') return path.resolve(argv[1])
  throw new Error('usage: node tools/security/check-retired-character-challenge-residue.mjs [--root <repository>]')
}

function splitNull(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean).map(normalizePath)
}

function gitFiles(root, args) {
  try {
    return splitNull(execFileSync('git', ['-C', root, 'ls-files', '-z', ...args], {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    }))
  } catch (error) {
    const detail = error.stderr?.toString('utf8').trim() || error.message
    throw new Error(`cannot enumerate repository files: ${detail}`)
  }
}

function walkFiles(root, relativeDirectory, output) {
  const absoluteDirectory = path.join(root, relativeDirectory)
  if (!fs.existsSync(absoluteDirectory)) return
  for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const relative = normalizePath(path.join(relativeDirectory, entry.name))
    if (entry.isDirectory()) walkFiles(root, relative, output)
    else if (entry.isFile() || entry.isSymbolicLink()) output.add(relative)
  }
}

function collectFiles(root) {
  const output = new Set(gitFiles(root, ['--cached', '--others', '--exclude-standard']))
  walkFiles(root, 'src/frontend/dist', output)
  walkFiles(root, 'src/backend/wwwroot', output)

  for (const relative of gitFiles(root, [
    '--others',
    '--ignored',
    '--exclude-standard',
    '--',
    ':(glob)**/*.tgz',
    ':(glob)**/*.wasm'
  ])) {
    if (!relative.split('/').includes('node_modules')) output.add(relative)
  }
  return [...output].sort()
}

function readOwnedBytes(root, relative) {
  const absolute = path.join(root, relative)
  let stat
  try {
    stat = fs.lstatSync(absolute)
  } catch {
    return null
  }
  if (stat.isSymbolicLink()) return Buffer.from(fs.readlinkSync(absolute))
  if (!stat.isFile()) return null
  return fs.readFileSync(absolute)
}

const minimumDeniedLength = 7

function digest(value) {
  return createHash('sha256').update(value.toLowerCase(), 'utf8').digest('hex')
}

function rollingHash(value, offset, length) {
  let hash = 0
  for (let index = offset; index < offset + length; index += 1) {
    hash = (Math.imul(hash, 257) + value.charCodeAt(index)) >>> 0
  }
  return hash
}

function inspectCandidate(value, output) {
  if (value.length < minimumDeniedLength) return
  const normalized = value.toLowerCase()

  // Long identifiers and paths must not hide a retired identifier as a prefix,
  // suffix, camel-case segment, or path segment. One rolling seven-character
  // prefix scan locates candidates; the full SHA-256 is checked only on a hit.
  let prefix = rollingHash(normalized, 0, minimumDeniedLength)
  let power = 1
  for (let index = 1; index < minimumDeniedLength; index += 1) power = Math.imul(power, 257) >>> 0
  for (let offset = 0; offset + minimumDeniedLength <= normalized.length; offset += 1) {
    const candidates = deniedByPrefix.get(prefix) ?? []
    for (const [length, expectedDigest] of candidates) {
      if (offset + length > normalized.length) continue
      const candidateDigest = digest(normalized.slice(offset, offset + length))
      if (candidateDigest === expectedDigest) output.add(candidateDigest)
    }
    if (offset + minimumDeniedLength < normalized.length) {
      prefix = Math.imul(
        (prefix - Math.imul(normalized.charCodeAt(offset), power)) >>> 0,
        257)
      prefix = (prefix + normalized.charCodeAt(offset + minimumDeniedLength)) >>> 0
    }
  }
}

function inspectText(text, output) {
  inspectCandidate(text, output)
}

function likelyUtf16(buffer, oddOffset) {
  if (buffer.length < minimumDeniedLength * 2) return false
  const pairs = Math.min(buffer.length / 2, 4096)
  let zeroes = 0
  for (let index = oddOffset; index < pairs * 2; index += 2) {
    if (buffer[index] === 0) zeroes += 1
  }
  return zeroes / pairs >= 0.2
}

function matches(buffer) {
  const found = new Set()
  inspectText(buffer.toString('utf8'), found)
  for (const byteOffset of [0, 1]) {
    const remaining = buffer.length - byteOffset
    if (remaining < minimumDeniedLength * 2) continue
    const evenLength = remaining - (remaining % 2)
    const view = buffer.subarray(byteOffset, byteOffset + evenLength)
    if (likelyUtf16(view, 1)) inspectText(view.toString('utf16le'), found)
    if (likelyUtf16(view, 0)) {
      const swapped = Buffer.from(view)
      swapped.swap16()
      inspectText(swapped.toString('utf16le'), found)
    }
  }
  return [...found].map(value => `fingerprint:${value}`)
}

function containsRetiredCharacterAlias(buffer) {
  const littleEndian = buffer.length % 2 === 0 ? buffer.toString('utf16le') : ''
  const bigEndian = buffer.length % 2 === 0
    ? Buffer.from(buffer).swap16().toString('utf16le')
    : ''
  return [buffer.toString('utf8'), littleEndian, bigEndian]
    .some(text => retiredAliasPatterns.some(pattern => pattern.test(text)))
}

function inspectArchive(root, relative) {
  const absolute = path.join(root, relative)
  const listing = spawnSync('tar', ['-tzf', absolute], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024
  })
  if (listing.status !== 0) {
    return {
      error: listing.stderr?.toString('utf8').trim() || listing.error?.message || 'tar listing failed',
      hits: [],
      retiredAlias: false
    }
  }
  const content = spawnSync('tar', ['-xOzf', absolute], {
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024
  })
  if (content.status !== 0) {
    return {
      error: content.stderr?.toString('utf8').trim() || content.error?.message || 'tar content read failed',
      hits: [],
      retiredAlias: false
    }
  }
  const listingBytes = Buffer.from(listing.stdout)
  const contentBytes = Buffer.from(content.stdout)
  const hits = new Set([
    ...matches(listingBytes),
    ...matches(contentBytes)
  ])
  return {
    error: null,
    hits: [...hits],
    retiredAlias: containsRetiredCharacterAlias(listingBytes) || containsRetiredCharacterAlias(contentBytes)
  }
}

function validateHistoricalNote(buffer) {
  const text = buffer.toString('utf8')
  const executablePatterns = [
    /```|~~~/u,
    /(?:=>|->|:=)/u,
    /^\s*[^\s#*-][^\n]*\s=\s*[^\n]+$/mu,
    /<script\b/iu,
    /^\s*(?:(?:export|public|private|internal)\s+)*(?:const|let|var|enum|class|interface|record|function)\s+[A-Za-z_$]/mu
  ]
  return executablePatterns.find(pattern => pattern.test(text)) ?? null
}

function main() {
  const root = parseRoot(process.argv.slice(2))
  const violations = []
  const contentScanCache = new Map()
  for (const relative of collectFiles(root)) {
    const bytes = readOwnedBytes(root, relative)
    if (bytes === null) continue
    const pathHits = matches(Buffer.from(relative))
    const contentIdentity = `${bytes.length}:${createHash('sha256').update(bytes).digest('hex')}`
    let contentScan = contentScanCache.get(contentIdentity)
    if (!contentScan) {
      contentScan = {
        hits: matches(bytes),
        retiredAlias: containsRetiredCharacterAlias(bytes)
      }
      contentScanCache.set(contentIdentity, contentScan)
    }
    const contentHits = contentScan.hits
    const hits = [...new Set([...pathHits, ...contentHits])]

    if (relative === historicalNote) {
      const invalidPattern = validateHistoricalNote(bytes)
      if (invalidPattern) violations.push(`${relative}: historical note contains executable contract syntax`)
      continue
    }

    for (const term of hits) violations.push(`${relative}: ${term}`)
    if (contentScan.retiredAlias) {
      violations.push(`${relative}: retired character-to-text-task presentation alias`)
    }
    if (relative.endsWith('.tgz')) {
      const archive = inspectArchive(root, relative)
      if (archive.error) violations.push(`${relative}: package archive cannot be inspected (${archive.error})`)
      for (const term of archive.hits) violations.push(`${relative}::<archive>: ${term}`)
      if (archive.retiredAlias) {
        violations.push(`${relative}::<archive>: retired character-to-text-task presentation alias`)
      }
    }
  }

  if (violations.length > 0) {
    console.error('[retired-character-challenge-residue] forbidden repository residue detected:')
    for (const violation of violations) console.error(`- ${violation}`)
    process.exitCode = 1
    return
  }
  console.log('[retired-character-challenge-residue] repository and package outputs are clean')
}

main()
