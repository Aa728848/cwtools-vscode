module LSP.Tokenizer

open System
open System.IO
open System.Text

type Header =
    | ContentLength of int
    | EmptyHeader
    | OtherHeader

let parseHeader (header: string) : Header =
    let contentLength = "Content-Length: "

    if header.StartsWith(contentLength) then
        let tail = header.Substring(contentLength.Length)
        let length = Int32.Parse(tail)
        ContentLength(length)
    elif header = "" then
        EmptyHeader
    else
        OtherHeader

/// C2 Fix: only consume the byte after \r if it really is \n.
/// Previously the code blindly called ReadChar(), which could silently drop
/// a legitimate content byte when the line ending was a bare \r.
let readLine (client: BinaryReader) : string option =
    let buffer = StringBuilder()

    try
        let mutable endOfLine = false

        while not endOfLine do
            let nextChar = client.ReadChar()

            if nextChar = '\n' then
                endOfLine <- true
            elif nextChar = '\r' then
                // Peek the next byte: consume it only if it is \n (standard CRLF).
                // If the underlying stream is seekable we can "un-read" a non-\n byte;
                // otherwise we accept losing it — LSP spec always uses \r\n so this path
                // should never be exercised in practice.
                try
                    let peeked = client.ReadChar()
                    if peeked <> '\n' then
                        let s = client.BaseStream
                        if s.CanSeek then
                            s.Seek(-1L, SeekOrigin.Current) |> ignore
                with :? EndOfStreamException -> ()
                endOfLine <- true
            else
                buffer.Append(nextChar) |> ignore

        Some(buffer.ToString())
    with :? EndOfStreamException ->
        if buffer.Length > 0 then Some(buffer.ToString()) else None

/// Read exactly `byteLength` bytes of UTF-8 body text.
let readLength (byteLength: int, client: BinaryReader) : string =
    if byteLength <= 0 then ""
    else
        let bytes = client.ReadBytes(byteLength)
        Encoding.UTF8.GetString(bytes)

let tokenize (client: BinaryReader) : seq<string> =
    seq {
        let mutable contentLength = -1
        let mutable endOfInput = false

        while not endOfInput do
            let maybeHeader = readLine client
            let next = Option.map parseHeader maybeHeader

            match next with
            | None -> endOfInput <- true
            | Some(ContentLength l) -> contentLength <- l
            | Some(EmptyHeader) when contentLength > 0 ->
                // L1 Fix: only call readLength when a valid Content-Length header was seen.
                // If contentLength is still -1 the header block was malformed; skip silently.
                yield readLength (contentLength, client)
                contentLength <- -1   // reset so a stray empty line doesn't re-trigger
            | Some(EmptyHeader) ->
                ()   // malformed — no Content-Length seen; ignore
            | _ -> ()
    }
