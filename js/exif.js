/* ==============================================================
   EXIF — reading where a photo was taken.

   The case this exists for: you tick something off, attach the photos
   you took while doing it, and the activity still has no location — so
   it never appears on the map, which is one of the two things the app
   is for. The photos already know where they were taken. Asking the
   user to type it in again is asking them for something they have
   already given us.

   ---- Why this is hand-rolled ----

   It is a fixed walk over a well-specified binary layout: JPEG segment
   markers → the APP1/Exif segment → a TIFF header → IFD0 → the GPS
   sub-IFD → four tags. That is the whole job, and it is smaller than
   the smallest EXIF library, with no dependency to keep current.

   ---- Where it has to be called from ----

   **Against the original File, before anything re-encodes it.**
   compress() in utils.js draws the image to a canvas and reads it back
   out with toDataURL(), and a canvas knows nothing about EXIF — every
   tag is gone from the result. So this runs in handleMedia() on the
   file as picked, not on anything uploadPhoto() has touched.

   ---- What it will and will not find ----

   Photos from a phone's camera roll normally carry GPS. Screenshots
   never do. Neither does anything shot with the in-app camera, or
   anything that has been through a messaging app — most of them strip
   metadata on send, which is a feature and not a bug.

   iOS is the one to watch: Safari has changed what it passes through a
   file input more than once across versions, and a HEIC converted to
   JPEG on the way out may or may not keep its GPS block. So every
   failure path here returns null and the caller simply does not offer
   a suggestion. It must never guess.
   ============================================================== */

/* EXIF lives at the very front of the file, immediately after the SOI
   marker. Reading a slice rather than the whole thing keeps a 12MP
   photo from being pulled into memory to look at its first few KB —
   the generous ceiling is for the occasional huge thumbnail or colour
   profile sitting in a segment ahead of APP1. */
const EXIF_SCAN_BYTES=256*1024;

/* Bytes per EXIF value type, indexed by the type code itself.
     1 BYTE  2 ASCII  3 SHORT  4 LONG  5 RATIONAL
     6 SBYTE 7 UNDEF  8 SSHORT 9 SLONG 10 SRATIONAL */
const EXIF_TYPE_SIZE=[0,1,1,2,4,8,1,1,2,4,8];

const EXIF_TAG_GPS_IFD=0x8825;
const EXIF_GPS_LAT_REF=0x0001, EXIF_GPS_LAT=0x0002;
const EXIF_GPS_LNG_REF=0x0003, EXIF_GPS_LNG=0x0004;

/* ---- The one entry point ----

   Two containers, because a phone produces both. JPEG keeps EXIF in an
   APP1 segment near the front; HEIC — which is what an iPhone shoots by
   default — keeps it as an addressable *item* inside an ISOBMFF box
   tree, and the bytes can be anywhere in the file.

   **Dispatch is on the magic bytes, not on `file.type`.** A file input
   on iOS reports the type inconsistently and sometimes reports nothing
   at all, and the bytes are the only thing that cannot be wrong. */
async function exifReadLocation(file){
  try{
    if(!file) return null;
    const head=await sliceBuffer(file,0,EXIF_SCAN_BYTES);
    if(!head||head.byteLength<12) return null;
    const view=new DataView(head);

    if(view.getUint16(0)===0xFFD8){                      /* JPEG SOI */
      const tiff=exifFindTiff(view);
      return tiff<0?null:exifGpsFrom(view,tiff);
    }
    if(isoType(view,4)==='ftyp'){                        /* HEIC/HEIF/AVIF */
      return await heicReadLocation(file,view);
    }
    /* PNG, GIF, WebP: no EXIF worth chasing here, and guessing at a
       layout is how a parser starts returning pixel data as a location. */
    return null;
  }catch(e){
    /* A truncated or malformed file is an ordinary outcome here, not
       an error worth surfacing — there is simply no location to offer. */
    console.warn('exifReadLocation:',e);
    return null;
  }
}

async function sliceBuffer(file,start,end){
  try{ return await file.slice(start,end).arrayBuffer(); }
  catch(e){ return null; }
}

/* Walk the JPEG segment markers to the start of the TIFF block inside
   APP1, or -1 if there isn't one. */
function exifFindTiff(view){
  if(view.byteLength<4||view.getUint16(0)!==0xFFD8) return -1;   /* SOI */

  let p=2;
  while(p+4<=view.byteLength){
    if(view.getUint8(p)!==0xFF) return -1;                       /* desynced */
    const marker=view.getUint8(p+1);

    /* Standalone markers: no length field to skip past. */
    if(marker===0x01||(marker>=0xD0&&marker<=0xD9)){ p+=2; continue; }
    /* Start of scan — image data from here on, so any metadata is
       behind us. */
    if(marker===0xDA) return -1;

    const size=view.getUint16(p+2);
    if(size<2) return -1;

    if(marker===0xE1&&p+10<=view.byteLength){
      /* "Exif\0\0" — APP1 is also used for XMP, which this is not. */
      if(view.getUint32(p+4)===0x45786966&&view.getUint16(p+8)===0x0000){
        return p+10;
      }
    }
    p+=2+size;
  }
  return -1;
}

/* ==============================================================
   HEIC — the same EXIF block, in a completely different container.

   An iPhone shoots HEIC by default. Safari usually converts it to JPEG
   on its way through a file input, but "usually" is doing real work in
   that sentence: it depends on the iOS version and on how the picker
   was opened, and when it does not convert, the whole feature silently
   does nothing. Which is exactly what it did.

   HEIC is ISOBMFF — the MP4 box tree — and EXIF is not a segment in it
   but an *item*, addressed indirectly:

     ftyp                         container brand
     meta                         (a FullBox: 4 bytes of version/flags)
       iinf → infe entries        which item id has item_type 'Exif'
       iloc → extents             where in the FILE that item's bytes are
     mdat                         ...and the bytes themselves, over here

   So it takes two reads: the box tree from the head of the file, then a
   targeted slice of just the EXIF item. Which is the nice part — the
   payload lands on an ordinary TIFF header, so everything below this
   section is reused unchanged. HEIC support is a new way to *find* the
   same block, not a second parser.

   AVIF uses the identical structure, so it comes along for free.
   ============================================================== */

/* An EXIF item is a few KB. The cap is only so a corrupt `iloc` cannot
   ask us to pull the entire file into memory. */
const HEIC_EXIF_MAX=512*1024;

function isoType(view,p){
  if(p+4>view.byteLength) return '';
  return String.fromCharCode(view.getUint8(p),view.getUint8(p+1),
                             view.getUint8(p+2),view.getUint8(p+3));
}

/* Walk the boxes between `start` and `end`, yielding each one's type and
   the bounds of its payload. */
function* isoBoxes(view,start,end){
  let p=start;
  while(p+8<=end){
    let size=view.getUint32(p);
    const type=isoType(view,p+4);
    let header=8;
    if(size===1){
      /* 64-bit size. Read as two 32-bit halves — the high word is never
         meaningfully large for anything we open, but it has to be
         consumed to find the payload. */
      if(p+16>end) return;
      size=view.getUint32(p+8)*4294967296+view.getUint32(p+12);
      header=16;
    } else if(size===0){
      size=end-p;                    /* extends to the end of the file */
    }
    if(size<header) return;          /* malformed; stop rather than loop */
    yield{type,start:p+header,end:Math.min(p+size,end)};
    p+=size;
  }
}

async function heicReadLocation(file,head){
  const ext=heicExifExtent(head);
  if(!ext||!ext.length) return null;

  const buf=await sliceBuffer(file,ext.offset,
    ext.offset+Math.min(ext.length,HEIC_EXIF_MAX));
  if(!buf) return null;
  const view=new DataView(buf);
  const tiff=heicTiffStart(view);
  return tiff<0?null:exifGpsFrom(view,tiff);
}

/* Where in the file the EXIF item's bytes live, or null. */
function heicExifExtent(view){
  let meta=null;
  for(const b of isoBoxes(view,0,view.byteLength)){
    if(b.type==='meta'){ meta=b; break; }
  }
  if(!meta) return null;

  let iinf=null,iloc=null;
  /* meta is a FullBox: its children start after version+flags. */
  for(const b of isoBoxes(view,meta.start+4,meta.end)){
    if(b.type==='iinf') iinf=b;
    else if(b.type==='iloc') iloc=b;
  }
  if(!iinf||!iloc) return null;

  const id=heicExifItemId(view,iinf);
  if(id===null) return null;
  return heicItemExtent(view,iloc,id);
}

/* The item id whose item_type is 'Exif'. */
function heicExifItemId(view,box){
  let p=box.start;
  const version=view.getUint8(p);
  p+=4;                                        /* version + flags */
  /* The entry count is read but not trusted — isoBoxes() is bounded by
     the box itself, which is the safer limit. */
  p+=version===0?2:4;

  for(const b of isoBoxes(view,p,box.end)){
    if(b.type!=='infe') continue;
    const v=view.getUint8(b.start);
    /* item_type only exists from version 2. Version 0/1 entries
       describe their type with a MIME string instead and never carry
       EXIF, so they are simply skipped. */
    if(v<2) continue;
    let q=b.start+4;
    let itemId;
    if(v>=3){ itemId=view.getUint32(q); q+=4; }
    else     { itemId=view.getUint16(q); q+=2; }
    q+=2;                                      /* item_protection_index */
    if(isoType(view,q)==='Exif') return itemId;
  }
  return null;
}

/* iloc is the awkward one: the width of every offset field is itself
   declared in the box, and the layout shifts across its three versions. */
function heicItemExtent(view,box,wantId){
  let p=box.start;
  const version=view.getUint8(p);
  p+=4;

  const a=view.getUint8(p),b=view.getUint8(p+1);
  const offsetSize=a>>4, lengthSize=a&15;
  const baseOffsetSize=b>>4;
  const indexSize=(version===1||version===2)?(b&15):0;
  p+=2;

  let count;
  if(version<2){ count=view.getUint16(p); p+=2; }
  else         { count=view.getUint32(p); p+=4; }

  const readN=(at,n)=>{
    if(!n) return 0;
    if(at+n>view.byteLength) return NaN;
    if(n===1) return view.getUint8(at);
    if(n===2) return view.getUint16(at);
    if(n===4) return view.getUint32(at);
    if(n===8) return view.getUint32(at)*4294967296+view.getUint32(at+4);
    return NaN;
  };

  for(let i=0;i<count;i++){
    if(p+2>box.end) return null;
    let itemId;
    if(version<2){ itemId=view.getUint16(p); p+=2; }
    else         { itemId=view.getUint32(p); p+=4; }
    if(version===1||version===2) p+=2;         /* construction_method */
    p+=2;                                      /* data_reference_index */

    const baseOffset=readN(p,baseOffsetSize); p+=baseOffsetSize;
    if(p+2>box.end) return null;
    const extents=view.getUint16(p); p+=2;

    for(let j=0;j<extents;j++){
      p+=indexSize;
      const off=readN(p,offsetSize); p+=offsetSize;
      const len=readN(p,lengthSize); p+=lengthSize;
      /* The first extent is the whole EXIF item in every file that has
         one; a fragmented item is legal but not something any camera
         produces, and stitching it is not worth guessing at. */
      if(itemId===wantId&&j===0){
        if(!isFinite(baseOffset)||!isFinite(off)||!isFinite(len)) return null;
        return{offset:baseOffset+off,length:len};
      }
    }
  }
  return null;
}

/* The EXIF item's payload opens with a 32-bit offset to the TIFF header
   — 6 in practice, stepping over an "Exif\0\0" prefix. */
function heicTiffStart(view){
  if(view.byteLength<12) return -1;
  const declared=4+view.getUint32(0);
  if(isTiffAt(view,declared)) return declared;
  /* Encoders do get this wrong. The byte-order marker is distinctive
     enough to find directly rather than give up over. */
  for(let p=0;p<Math.min(64,view.byteLength-4);p++){
    if(isTiffAt(view,p)) return p;
  }
  return -1;
}

function isTiffAt(view,p){
  if(p<0||p+4>view.byteLength) return false;
  const order=view.getUint16(p);
  if(order!==0x4949&&order!==0x4D4D) return false;
  return view.getUint16(p+2,order===0x4949)===0x002A;
}

/* Read the GPS sub-IFD and turn its four tags into decimal degrees. */
function exifGpsFrom(view,tiff){
  if(tiff+8>view.byteLength) return null;

  const order=view.getUint16(tiff);
  if(order!==0x4949&&order!==0x4D4D) return null;
  const le=order===0x4949;                                   /* "II" = Intel */
  if(view.getUint16(tiff+2,le)!==0x002A) return null;

  const ifd0=view.getUint32(tiff+4,le);
  const gpsPtr=exifTagValue(view,tiff,le,tiff+ifd0,EXIF_TAG_GPS_IFD);
  if(!gpsPtr||!gpsPtr.length) return null;

  const gps=tiff+gpsPtr[0];
  const lat=exifTagValue(view,tiff,le,gps,EXIF_GPS_LAT);
  const lng=exifTagValue(view,tiff,le,gps,EXIF_GPS_LNG);
  const latRef=exifTagValue(view,tiff,le,gps,EXIF_GPS_LAT_REF,true);
  const lngRef=exifTagValue(view,tiff,le,gps,EXIF_GPS_LNG_REF,true);
  if(!lat||lat.length<3||!lng||lng.length<3) return null;

  let latD=exifDMS(lat), lngD=exifDMS(lng);
  if(latD===null||lngD===null) return null;
  if((latRef||'N').toUpperCase().startsWith('S')) latD=-latD;
  if((lngRef||'E').toUpperCase().startsWith('W')) lngD=-lngD;

  if(!isFinite(latD)||!isFinite(lngD)) return null;
  if(Math.abs(latD)>90||Math.abs(lngD)>180) return null;
  /* Null Island. A camera that wrote a GPS block without ever getting
     a fix leaves exact zeroes, and offering the user "the Atlantic
     Ocean" is worse than offering nothing. */
  if(latD===0&&lngD===0) return null;

  return{lat:latD,lng:lngD};
}

/* Degrees/minutes/seconds, as three rationals, to a decimal degree. */
function exifDMS(parts){
  const[d,m,s]=parts;
  if(!isFinite(d)||!isFinite(m)||!isFinite(s)) return null;
  return d+m/60+s/3600;
}

/* Find one tag in the IFD at `ifd` and read its value. Returns an array
   of numbers, or a string when `asText`, or null if the tag is absent.

   Offsets inside an IFD are all relative to the start of the TIFF
   block, never to the file or to the IFD — which is why `tiff` has to
   be threaded through everything here. */
function exifTagValue(view,tiff,le,ifd,wanted,asText){
  if(ifd+2>view.byteLength) return null;
  const count=view.getUint16(ifd,le);
  /* A plausible IFD has tens of entries. A four-figure count means we
     are reading something that is not an IFD at all. */
  if(count>512) return null;

  for(let i=0;i<count;i++){
    const entry=ifd+2+i*12;
    if(entry+12>view.byteLength) return null;
    if(view.getUint16(entry,le)!==wanted) continue;

    const type=view.getUint16(entry+2,le);
    const n=view.getUint32(entry+4,le);
    const unit=EXIF_TYPE_SIZE[type]||0;
    if(!unit||!n||n>256) return null;

    const total=unit*n;
    /* Four bytes or fewer are stored in the entry itself; anything
       larger is an offset to where the value really lives. */
    const at=total<=4?entry+8:tiff+view.getUint32(entry+8,le);
    if(at<0||at+total>view.byteLength) return null;

    if(asText||type===2){
      let s='';
      for(let j=0;j<n;j++){
        const c=view.getUint8(at+j);
        if(!c) break;                                  /* NUL-terminated */
        s+=String.fromCharCode(c);
      }
      return s.trim();
    }

    const out=[];
    for(let j=0;j<n;j++){
      const o=at+j*unit;
      if(type===5||type===10){
        const num=type===5?view.getUint32(o,le):view.getInt32(o,le);
        const den=type===5?view.getUint32(o+4,le):view.getInt32(o+4,le);
        out.push(den?num/den:0);
      }
      else if(type===3||type===8) out.push(type===3?view.getUint16(o,le):view.getInt16(o,le));
      else if(type===4||type===9) out.push(type===4?view.getUint32(o,le):view.getInt32(o,le));
      else out.push(view.getUint8(o));
    }
    return out;
  }
  return null;
}
