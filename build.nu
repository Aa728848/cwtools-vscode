def main [profile? : string] {

dotnet tool restore
git submodule update --init --recursive
dotnet run --project build -- -t ($profile | default "QuickBuild")
}
