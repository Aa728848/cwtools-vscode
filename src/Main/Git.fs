module Main.Git

open LibGit2Sharp
open System
open System.IO
open System.Linq
open CWTools.Utilities.Utils

let rec initOrUpdateRules repoPath gameCacheDir first =
    if Directory.Exists gameCacheDir then
        ()
    else
        Directory.CreateDirectory gameCacheDir |> ignore

    try
        let mutable isRepo = Repository.IsValid gameCacheDir

        let shouldReplaceCache =
            if isRepo then
                use existingGit = new Repository(gameCacheDir)
                match existingGit.Network.Remotes["origin"] with
                | null -> false
                | existingRemote ->
                    not (String.Equals(existingRemote.Url, repoPath, StringComparison.OrdinalIgnoreCase))
            else
                false

        if shouldReplaceCache then
            logInfo $"cwtools rules remote changed; rebuilding rules cache from %s{repoPath}"
            Directory.Delete(gameCacheDir, true)
            Directory.CreateDirectory(gameCacheDir) |> ignore
            isRepo <- false

        if isRepo then
            ()
        else
            if Directory.Exists gameCacheDir then
                try Directory.Delete(gameCacheDir, true) with _ -> ()
            Repository.Clone(repoPath, gameCacheDir) |> ignore

        let git = new Repository(gameCacheDir)
        let remote =
            match git.Network.Remotes["origin"] with
            | null -> git.Network.Remotes.Add("origin", repoPath)
            | existingRemote -> existingRemote
        let refSpecs = remote.FetchRefSpecs.Select(fun x -> x.Specification)
        Commands.Fetch(git, remote.Name, refSpecs, null, "")
        let currentHash = git.Head.Tip.Sha
        logInfo $"cwtools current rules version: %A{currentHash}"

        let tryFindRemoteDefaultBranch (r: Repository) =
            [ "origin/master"; "origin/main" ]
            |> Seq.tryPick (fun branchName ->
                match r.Branches[branchName] with
                | null -> None
                | branch -> Some branch)

        let remoteBranch =
            tryFindRemoteDefaultBranch git
            |> Option.defaultWith (fun () ->
                failwith "Could not find a fetched origin/master or origin/main branch for CWTools rules.")

        // The rules cache tracks the remote default branch; there is no
        // separate "stable" (tagged) channel anymore.
        git.Reset(ResetMode.Hard, remoteBranch.Tip)

        let newHash = git.Head.Tip.Sha
        logInfo $"cwtools new rules version: %A{newHash}"
        (newHash <> currentHash) || not isRepo, Some git.Head.Tip.Committer.When
    with ex ->
        logError $"cwtools git error, recovering, error: %A{ex}"
        try
            use git = new Repository(gameCacheDir)
            match [ "origin/master"; "origin/main" ] |> Seq.tryPick (fun b -> match git.Branches[b] with null -> None | br -> Some br) with
            | Some branch -> git.Reset(ResetMode.Hard, branch.Tip)
            | None -> logError "cwtools git recovery failed: could not find origin/master or origin/main branch"
        with innerEx ->
            logError $"cwtools git recovery failed: %A{innerEx}"


        if first then
            initOrUpdateRules repoPath gameCacheDir false
        else
            (false, None)
