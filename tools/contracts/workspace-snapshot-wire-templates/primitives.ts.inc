function invalid(): never { throw new Error('invalid_workspace_snapshot_wire'); }
function exact(value: unknown, keys: string[]): void { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid(); }
function integer(value: number, min: number, max: number): void { if(!Number.isSafeInteger(value)||value<min||value>max) invalid(); }
function text(value: string, max: number, kind: string): void { if(typeof value!=='string'||value.length>max || (kind==='id'&&!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/u.test(value)) || (kind==='digest'&&!/^[a-f0-9]{64}$/u.test(value)) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) invalid(); }
class Reader {
private offset=0;
private readonly view: DataView;
private readonly bytes: Uint8Array;
private readonly decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
public constructor(bytes: Uint8Array) {this.bytes=bytes;if(!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>65536)invalid();this.view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);}
private take(count: number): Uint8Array {if(count<0||count>this.bytes.length-this.offset)invalid();const value=this.bytes.subarray(this.offset,this.offset+count);this.offset+=count;return value;}
public byte(): number {return this.take(1)[0]!;}
public boolean(): boolean {const value=this.byte();if(value>1)invalid();return value===1;}
public int32(min: number,max: number): number {const position=this.offset;this.take(4);const value=this.view.getInt32(position,true);integer(value,min,max);return value;}
public int64(min: number,max: number): number {const position=this.offset;this.take(8);const raw=this.view.getBigInt64(position,true);if(raw<BigInt(min)||raw>BigInt(max))invalid();return Number(raw);}
public closed<T extends string>(values: readonly T[]): T {const value=values[this.byte()];if(value===undefined)invalid();return value;}
public text(max: number,kind: string): string {const length=this.int32(0,max*4);const value=this.decoder.decode(this.take(length));text(value,max,kind);return value;}
public array<T>(min: number,max: number,read: ()=>T): T[] {const count=this.int32(min,max);if(count>this.bytes.length-this.offset)invalid();return Array.from({length:count},read);}
public consumed(): boolean {return this.offset===this.bytes.length;}
}
class Writer {
private readonly bytes: number[]=[];
public byte(value: number): void {integer(value,0,255);if(this.bytes.length>=65536)invalid();this.bytes.push(value);}
public boolean(value: boolean): void {if(typeof value!=='boolean')invalid();this.byte(value?1:0);}
public int32(value: number,min: number,max: number): void {integer(value,min,max);const buffer=new Uint8Array(4);new DataView(buffer.buffer).setInt32(0,value,true);for(const item of buffer)this.byte(item);}
public int64(value: number,min: number,max: number): void {integer(value,min,max);const buffer=new Uint8Array(8);new DataView(buffer.buffer).setBigInt64(0,BigInt(value),true);for(const item of buffer)this.byte(item);}
public closed(value: string,values: readonly string[]): void {const index=values.indexOf(value);if(index<0)invalid();this.byte(index);}
public text(value: string,max: number,kind: string): void {text(value,max,kind);const bytes=new TextEncoder().encode(value);this.int32(bytes.length,0,max*4);for(const item of bytes)this.byte(item);}
public result(): Uint8Array {return Uint8Array.from(this.bytes);}
}
