module VisitorTest
open CWTools.Games
type IGameVisitor<'R> =
    abstract Visit<'T> : IGame<'T> -> 'R
