use std::{
    cell::RefCell,
    path::Path,
    time::{Duration, Instant},
};
use tauri::ipc::Channel;
use windows::{
    Win32::{
        Foundation::E_ABORT,
        System::Com::{
            CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
            CoTaskMemFree, CoUninitialize,
        },
        UI::Shell::{
            FOF_ALLOWUNDO, FOF_NOERRORUI, FOF_SILENT, FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE,
            FileOperation, IFileOperation, IFileOperationProgressSink,
            IFileOperationProgressSink_Impl, IShellItem, SHCreateItemFromParsingName,
            SIGDN_FILESYSPATH, TSF_DELETE_RECYCLE_IF_POSSIBLE,
        },
    },
    core::{HRESULT, PCWSTR, Ref, Result, implement},
};

#[implement(IFileOperationProgressSink)]
struct RecycleSink {
    progress: Channel<super::RecycleProgress>,
    state: RefCell<ProgressState>,
}

struct ProgressState {
    current: String,
    total: u32,
    done: u32,
    last_emit: Option<Instant>,
    recycled: bool,
}

impl RecycleSink {
    fn emit(&self, state: &mut ProgressState) {
        if state
            .last_emit
            .is_some_and(|t| t.elapsed() < Duration::from_millis(150))
        {
            return;
        }
        let _ = self.progress.send(super::RecycleProgress {
            current: state.current.clone(),
            total: state.total,
            done: state.done,
        });
        state.last_emit = Some(Instant::now());
    }
}

impl IFileOperationProgressSink_Impl for RecycleSink_Impl {
    fn PreDeleteItem(&self, flags: u32, item: Ref<'_, IShellItem>) -> Result<()> {
        // Refuse items the Shell cannot send to the Recycle Bin.
        if flags & TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32 == 0 {
            return Err(E_ABORT.into());
        }
        let mut state = self.state.borrow_mut();
        if let Some(item) = item.as_ref() {
            unsafe {
                if let Ok(name) = item.GetDisplayName(SIGDN_FILESYSPATH) {
                    if let Ok(path) = name.to_string() {
                        state.current = path;
                    }
                    CoTaskMemFree(Some(name.0.cast()));
                }
            }
        }
        self.emit(&mut state);
        Ok(())
    }

    fn PostDeleteItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        result: HRESULT,
        recycled: Ref<'_, IShellItem>,
    ) -> Result<()> {
        result.ok()?;
        if recycled.as_ref().is_none() {
            return Err(E_ABORT.into());
        }
        self.state.borrow_mut().recycled = true;
        Ok(())
    }

    fn UpdateProgress(&self, total: u32, done: u32) -> Result<()> {
        let mut state = self.state.borrow_mut();
        if state.total == 0 && total > 0 {
            state.last_emit = None;
        }
        state.total = total;
        state.done = done;
        self.emit(&mut state);
        Ok(())
    }

    fn StartOperations(&self) -> Result<()> {
        Ok(())
    }
    fn FinishOperations(&self, _: HRESULT) -> Result<()> {
        Ok(())
    }
    fn PreRenameItem(&self, _: u32, _: Ref<'_, IShellItem>, _: &PCWSTR) -> Result<()> {
        Ok(())
    }
    fn PostRenameItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<'_, IShellItem>,
    ) -> Result<()> {
        Ok(())
    }
    fn PreMoveItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
    ) -> Result<()> {
        Ok(())
    }
    fn PostMoveItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<'_, IShellItem>,
    ) -> Result<()> {
        Ok(())
    }
    fn PreCopyItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
    ) -> Result<()> {
        Ok(())
    }
    fn PostCopyItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<'_, IShellItem>,
    ) -> Result<()> {
        Ok(())
    }
    fn PreNewItem(&self, _: u32, _: Ref<'_, IShellItem>, _: &PCWSTR) -> Result<()> {
        Ok(())
    }
    fn PostNewItem(
        &self,
        _: u32,
        _: Ref<'_, IShellItem>,
        _: &PCWSTR,
        _: &PCWSTR,
        _: u32,
        _: HRESULT,
        _: Ref<'_, IShellItem>,
    ) -> Result<()> {
        Ok(())
    }
    fn ResetTimer(&self) -> Result<()> {
        Ok(())
    }
    fn PauseTimer(&self) -> Result<()> {
        Ok(())
    }
    fn ResumeTimer(&self) -> Result<()> {
        Ok(())
    }
}

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

pub(super) fn recycle_one(
    path: &str,
    progress: Channel<super::RecycleProgress>,
) -> Result<()> {
    let source = Path::new(path);
    if !source.is_absolute() || source.parent().is_none() || path.contains('\0') {
        return Err(E_ABORT.into());
    }
    let wide: Vec<u16> = path.encode_utf16().chain([0]).collect();
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        let _apartment = Apartment;
        let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None)?;
        let operation: IFileOperation =
            CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)?;
        operation.SetOperationFlags(
            FOF_ALLOWUNDO | FOFX_RECYCLEONDELETE | FOFX_EARLYFAILURE | FOF_NOERRORUI | FOF_SILENT,
        )?;
        let sink = windows::core::ComObject::new(RecycleSink {
            progress,
            state: RefCell::new(ProgressState {
                current: path.to_owned(),
                total: 0,
                done: 0,
                last_emit: None,
                recycled: false,
            }),
        });
        let interface = sink.as_interface::<IFileOperationProgressSink>();
        let cookie = operation.Advise(&*interface)?;
        operation.DeleteItem(&item, None)?;
        let result = operation.PerformOperations();
        operation.Unadvise(cookie)?;
        result?;
        if operation.GetAnyOperationsAborted()?.as_bool() || !sink.state.borrow().recycled {
            return Err(E_ABORT.into());
        }
        Ok(())
    }
}
