//! The menu bar items' figures and names, set with CoreText into the same coverage mask as their
//! drawings (macOS only). A tray title is one line in the menu bar's own font, so it can't put a
//! small name under a figure, keep its width as the digits change, or turn a name on its side;
//! drawn into the item's image, it can do all three, and it's tinted with the drawing.

use std::f64::consts::FRAC_PI_2;
use std::ptr::null;

use objc2_core_foundation::{
    CFArray, CFAttributedString, CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType,
};
use objc2_core_graphics::{CGBitmapContextCreate, CGContext, CGImageAlphaInfo};
use objc2_core_text::{
    CTFont, CTFontDescriptor, CTFontUIFontType, CTLine, kCTFontAttributeName, kCTFontFeatureSettingsAttribute,
    kCTFontOpenTypeFeatureTag, kCTFontOpenTypeFeatureValue, kCTFontTraitsAttribute, kCTFontWeightTrait,
    kCTForegroundColorFromContextAttributeName,
};

use crate::menubar::Mask;

/// A font at a size in pixels (the menu bar's images are at twice its points).
pub struct Face(CFRetained<CTFont>);

impl Face {
    /// The system font at `px`, of `weight` (CoreText's scale: 0 regular, 0.23 medium, 0.3
    /// semibold, 0.4 bold), with tabular digits, so a figure's width doesn't move as it changes.
    pub fn system(px: f64, weight: f64) -> Face {
        // SAFETY: the keys and values are the types CoreText documents for them.
        unsafe {
            let base = CTFont::new_ui_font_for_language(CTFontUIFontType::System, px, None).expect("the system font");
            let tnum = CFDictionary::<CFString, CFType>::from_slices(
                &[kCTFontOpenTypeFeatureTag, kCTFontOpenTypeFeatureValue],
                &[&CFString::from_static_str("tnum"), &CFNumber::new_i32(1)],
            );
            let features = CFArray::<CFType>::from_objects(&[&*tnum]);
            let traits =
                CFDictionary::<CFString, CFType>::from_slices(&[kCTFontWeightTrait], &[&CFNumber::new_f64(weight)]);
            let attrs = CFDictionary::<CFString, CFType>::from_slices(
                &[kCTFontFeatureSettingsAttribute, kCTFontTraitsAttribute],
                &[&*features, &*traits],
            );
            let desc = CTFontDescriptor::with_attributes(attrs.as_opaque());
            Face(base.copy_with_attributes(0.0, null(), Some(&desc)))
        }
    }

    /// A font by its name, as CoreText finds it (its nearest match when it isn't installed).
    pub fn named(name: &str, px: f64) -> Face {
        // SAFETY: no matrix.
        Face(unsafe { CTFont::with_name(&CFString::from_str(name), px, null()) })
    }

    pub fn cap_height(&self) -> f64 {
        // SAFETY: a valid font.
        unsafe { self.0.cap_height() }
    }

    pub fn descent(&self) -> f64 {
        // SAFETY: a valid font.
        unsafe { self.0.descent() }
    }

    fn line(&self, text: &str) -> CFRetained<CTLine> {
        // SAFETY: the attributes are a font and a boolean, as CoreText documents them.
        unsafe {
            let attrs = CFDictionary::<CFString, CFType>::from_slices(
                &[kCTFontAttributeName, kCTForegroundColorFromContextAttributeName],
                &[&*self.0, CFBoolean::new(true)],
            );
            let s = CFAttributedString::new(None, Some(&CFString::from_str(text)), Some(attrs.as_opaque()))
                .expect("an attributed string");
            CTLine::with_attributed_string(&s)
        }
    }

    /// How far `text` advances the pen, in pixels.
    pub fn width(&self, text: &str) -> f64 {
        // SAFETY: null for the metrics not wanted.
        unsafe { self.line(text).typographic_bounds(std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()) }
    }

    /// Sets `text` into `mask`, its baseline starting at `x`, `baseline` (pixels from the top
    /// left). With `turned`, a quarter turn to the left, reading upwards: that point is then the
    /// bottom end of its baseline.
    pub fn draw(&self, mask: &mut Mask, text: &str, x: f64, baseline: f64, turned: bool) {
        let (w, h) = (mask.width as usize, mask.height as usize);
        // SAFETY: the context draws into `mask.alpha`, one byte a pixel and `w` a row, which lives
        // (and isn't otherwise touched) until it's dropped at the end of this block.
        unsafe {
            let Some(cx) =
                CGBitmapContextCreate(mask.alpha.as_mut_ptr().cast(), w, h, 8, w, None, CGImageAlphaInfo::Only.0)
            else {
                log::warn!("can't make a context to set {text:?} in");
                return;
            };
            let c = Some(&*cx);
            CGContext::set_gray_fill_color(c, 0.0, 1.0);
            CGContext::set_should_smooth_fonts(c, false);
            // CoreGraphics counts up from the bottom.
            CGContext::translate_ctm(c, x, h as f64 - baseline);
            if turned {
                CGContext::rotate_ctm(c, FRAC_PI_2);
            }
            CGContext::set_text_position(c, 0.0, 0.0);
            self.line(text).draw(&cx);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digits_are_tabular() {
        let f = Face::system(22.0, 0.23);
        assert_eq!(f.width("11%"), f.width("88%"));
        assert!(f.width("100%") > f.width("88%"));
    }

    #[test]
    fn a_heavier_weight_is_taken() {
        assert!(Face::system(22.0, 0.4).width("100%") > Face::system(22.0, 0.0).width("100%"));
    }

    #[test]
    fn text_lands_where_it_is_put() {
        let f = Face::system(22.0, 0.0);
        let mut m = Mask::new(80, 36);
        f.draw(&mut m, "88%", 10.0, 20.0, false);
        let ink = |x0: u32, x1: u32, y0: u32, y1: u32| {
            (y0..y1).flat_map(|y| (x0..x1).map(move |x| (x, y))).map(|(x, y)| m.at(x, y) as u32).sum::<u32>()
        };
        assert!(ink(10, 50, 4, 20) > 1000);
        assert_eq!(ink(0, 9, 0, 36), 0);
        assert_eq!(ink(0, 80, 22, 36), 0);
    }
}
